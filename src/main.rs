mod access;
mod ai;
mod auth;
mod branding;
mod browser;
mod dev;
mod projects;
mod protocol;
mod remote;
mod terminal;
mod transport;
mod workspace;

use access::{AccessPolicy, DevicePermissions};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        ConnectInfo, DefaultBodyLimit, OriginalUri, Query, Request, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use protocol::{Command, Envelope, Error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Semaphore, broadcast, watch};

const MAX_CLIENTS: usize = 8;
const MAX_TOKENS: usize = 16;
const MAX_FRAME: usize = 6 * workspace::MAX_FILE + 8192;

fn secret() -> String {
    (0..4)
        .map(|_| format!("{:016x}", rand::random::<u64>()))
        .collect()
}

#[derive(Serialize, Deserialize)]
struct ProjectPreference {
    workspace: PathBuf,
}

fn read_project_record(path: &Path) -> std::io::Result<Option<PathBuf>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "Project preference must be a regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes)?;
    if bytes.len() > 8192 {
        return Err(std::io::Error::other("Project preference is too large"));
    }
    let preference: ProjectPreference = serde_json::from_slice(&bytes)?;
    if !preference.workspace.is_absolute() {
        return Err(std::io::Error::other(
            "Project preference must contain an absolute folder",
        ));
    }
    Ok(Some(preference.workspace))
}

fn read_project_preference(path: &Path) -> Option<PathBuf> {
    let root = read_project_record(path).ok()??;
    if !root.is_dir() {
        return None;
    }
    std::fs::canonicalize(root).ok()
}

fn write_project_preference(path: &Path, workspace: &Path) -> std::io::Result<()> {
    use std::io::Write;
    let directory = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Missing preference directory",
        )
    })?;
    if std::fs::symlink_metadata(directory).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(std::io::Error::other(
            "Project preference directory is a symlink",
        ));
    }
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let temporary = directory.join(format!(".last-project-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(
            &mut file,
            &ProjectPreference {
                workspace: workspace.to_owned(),
            },
        )?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg(target_os = "macos")]
fn pick_project(root: &Path, shutdown: &watch::Sender<bool>) -> protocol::Result<Option<String>> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let script = "on run argv\nactivate\nset selectedFolder to choose folder with prompt \"Open a project in Nimlo\" default location (POSIX file (item 1 of argv))\nreturn POSIX path of selectedFolder\nend run";
    let mut picker = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            Error::new(
                "picker_unavailable",
                "The folder picker could not be opened on this PC",
            )
        })?;
    let started = Instant::now();
    let status = loop {
        if *shutdown.borrow() {
            let _ = picker.kill();
            let _ = picker.wait();
            return Err(Error::new(
                "picker_cancelled",
                "The host closed the folder picker",
            ));
        }
        match picker.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                std::thread::sleep(Duration::from_millis(40))
            }
            _ => {
                let _ = picker.kill();
                let _ = picker.wait();
                return Err(Error::new(
                    "picker_timeout",
                    "Folder selection timed out; try again",
                ));
            }
        }
    };
    let mut output = Vec::new();
    picker
        .stdout
        .take()
        .unwrap()
        .take(4097)
        .read_to_end(&mut output)
        .map_err(Error::io)?;
    if !status.success() {
        let mut error = String::new();
        picker
            .stderr
            .take()
            .unwrap()
            .take(4096)
            .read_to_string(&mut error)
            .map_err(Error::io)?;
        if error.contains("(-128)") {
            return Ok(None);
        }
        return Err(Error::new(
            "picker_unavailable",
            "The folder picker could not be opened on this PC",
        ));
    }
    if output.len() > 4096 {
        return Err(Error::new("path", "The selected folder path is too long"));
    }
    let path = String::from_utf8(output)
        .map_err(|_| Error::new("path", "Use a folder with a UTF-8 path"))?;
    Ok(Some(path.trim_end_matches(['\r', '\n']).to_owned()))
}

#[cfg(not(target_os = "macos"))]
fn pick_project(_root: &Path, _shutdown: &watch::Sender<bool>) -> protocol::Result<Option<String>> {
    Err(Error::new(
        "picker_unavailable",
        "Enter the absolute project folder path on the host PC",
    ))
}

#[derive(Clone)]
struct Config {
    workspace: PathBuf,
    state_dir: Option<PathBuf>,
    listen: SocketAddr,
    origin: Option<String>,
    connect_urls: Vec<String>,
    project_preference: Option<PathBuf>,
    state_owner: Option<PathBuf>,
    open_browser: bool,
    desktop: bool,
    dev_assets: Option<PathBuf>,
}

impl Config {
    fn pc_origin(&self) -> String {
        let ip = if self.listen.ip().is_unspecified() {
            if self.listen.is_ipv4() {
                IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
            } else {
                IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
            }
        } else {
            self.listen.ip()
        };
        format!("http://{}", SocketAddr::new(ip, self.listen.port()))
    }
    fn parse() -> std::result::Result<Self, String> {
        let mut config = Self {
            workspace: std::env::current_dir().map_err(|e| e.to_string())?,
            state_dir: None,
            listen: "127.0.0.1:7410".parse().unwrap(),
            origin: None,
            connect_urls: Vec::new(),
            state_owner: None,
            open_browser: false,
            desktop: false,
            dev_assets: None,
            project_preference: std::env::var_os("HOME")
                .map(|home| branding::state_root(Path::new(&home)).join("last-project.json")),
        };
        let mut resume_project = false;
        let mut explicit_workspace = false;
        let mut args = std::env::args().skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--workspace" => {
                    explicit_workspace = true;
                    config.workspace =
                        PathBuf::from(args.next().ok_or("--workspace requires a path")?)
                }
                "--resume-project" => resume_project = true,
                "--open-browser" => config.open_browser = true,
                "--desktop" => config.desktop = true,
                "--dev-assets" => {
                    config.dev_assets = Some(
                        std::fs::canonicalize(
                            args.next().ok_or("--dev-assets requires a directory")?,
                        )
                        .map_err(|error| error.to_string())?,
                    );
                }
                "--state-dir" => {
                    config.state_dir = Some(PathBuf::from(
                        args.next().ok_or("--state-dir requires a path")?,
                    ))
                }
                "--listen" => {
                    config.listen = args
                        .next()
                        .ok_or("--listen requires IP:PORT")?
                        .parse()
                        .map_err(|_| "--listen requires an IP address and port")?
                }
                "--origin" => {
                    let origin = args
                        .next()
                        .ok_or("--origin requires https://your-private-tunnel-host")?;
                    if !(origin.starts_with("https://") || origin.starts_with("http://localhost:"))
                        || origin[origin.find("://").unwrap() + 3..].contains('/')
                        || origin.contains('@')
                        || origin.contains('?')
                        || origin.contains('#')
                    {
                        return Err("--origin must be a single HTTPS origin, such as https://nimlo.example.ts.net".into());
                    }
                    config.origin = Some(origin);
                }
                "--help" | "-h" => {
                    println!(
                        "nimlo-editor [--workspace PATH] [--resume-project] [--open-browser] [--listen IP:PORT] [--state-dir PATH] [--origin https://TUNNEL-HOST] [--desktop] [--dev-assets DIR]\n\nDefaults: current workspace, loopback 127.0.0.1:7410. --resume-project opens the last project selected in Settings; explicit --workspace always takes precedence. --open-browser opens the private PC launch link in your default browser. --desktop emits a private JSON launch event and exits on stdin EOF; reserved for a parent window. --dev-assets serves editable UI files on loopback only, with internet pairing disabled. Pair a device can create an HTTPS internet link on demand with cloudflared; --origin uses an existing HTTPS tunnel. Recovery is stored in ~/.nimlo/<workspace-id>."
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("Unknown argument: {argument}")),
            }
        }
        if let Some(directory) = &config.state_dir {
            config.project_preference = Some(directory.join("last-project.json"));
        }
        if resume_project
            && !explicit_workspace
            && let Some(path) = config
                .project_preference
                .as_deref()
                .and_then(read_project_preference)
        {
            config.workspace = path;
        }
        if !config.listen.ip().is_loopback() && !config.listen.ip().is_unspecified() {
            return Err("--listen must use loopback or 0.0.0.0/[::]; the private PC login requires a loopback listener".into());
        }
        if config.dev_assets.is_some()
            && (!config.listen.ip().is_loopback() || config.origin.is_some())
        {
            return Err("Development assets require a loopback listener without --origin".into());
        }
        if config.desktop && (config.open_browser || !config.listen.ip().is_loopback()) {
            return Err("--desktop requires loopback and cannot use --open-browser".into());
        }
        Ok(config)
    }

    fn projects_path(&self) -> Option<PathBuf> {
        self.state_dir
            .as_ref()
            .map(|directory| directory.join("projects.json"))
            .or_else(|| {
                self.project_preference
                    .as_ref()
                    .and_then(|path| path.parent())
                    .map(|directory| directory.join("projects.json"))
            })
    }

    fn access_settings_path(&self) -> Option<PathBuf> {
        self.projects_path()
            .map(|path| path.with_file_name("device-access.json"))
    }

    fn project_state(&self, root: &Path) -> Option<PathBuf> {
        self.state_dir.as_ref().map(|directory| {
            if self.state_owner.as_deref() == Some(root) {
                directory.clone()
            } else {
                directory
                    .join("projects")
                    .join(workspace::recovery_id(root))
            }
        })
    }

    fn prepare_state(&mut self, root: &Path) -> std::result::Result<(), String> {
        if let Some(directory) = &self.state_dir {
            let marker = read_project_record(&directory.join("project-root.json"))
                .map_err(|error| format!("Cannot read recovery directory ownership: {error}"))?;
            self.state_owner = Some(match marker {
                Some(owner) => owner,
                None => workspace::Workspace::recovery_owner(directory)
                    .map_err(|error| error.message)?
                    .unwrap_or_else(|| root.to_owned()),
            });
        }
        Ok(())
    }

    fn local_headers(&self, headers: &HeaderMap) -> bool {
        // A proxy can connect from loopback. Forwarded headers never grant
        // privileges, and their presence prevents native desktop privileges.
        if headers.keys().any(|name| {
            matches!(name.as_str(), "forwarded" | "x-real-ip")
                || name.as_str().starts_with("x-forwarded-")
                || name.as_str().starts_with("cf-")
        }) {
            return false;
        }
        headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            .is_some_and(|host| {
                host.parse::<SocketAddr>()
                    .is_ok_and(|address| address.ip().is_loopback())
                    || host == format!("localhost:{}", self.listen.port())
            })
    }

    fn accepts_local_host(&self, host: &str) -> bool {
        if host == format!("localhost:{}", self.listen.port()) {
            return self.listen.ip().is_loopback() || self.listen.ip().is_unspecified();
        }
        let Ok(address) = host.parse::<SocketAddr>() else {
            return false;
        };
        if address.port() != self.listen.port() {
            return false;
        }
        if self.listen.ip().is_loopback() {
            address.ip().is_loopback()
        } else {
            address.ip() == self.listen.ip()
                || (self.listen.ip().is_unspecified() && address.ip().is_loopback())
                || self.connect_urls.contains(&format!("http://{address}"))
        }
    }
    fn expected_origin(&self, host: &str, tunnel_origin: Option<&str>) -> Option<String> {
        for origin in self.origin.as_deref().into_iter().chain(tunnel_origin) {
            if origin.split_once("://").map(|(_, authority)| authority) == Some(host) {
                return Some(origin.to_owned());
            }
        }
        self.accepts_local_host(host)
            .then(|| format!("http://{host}"))
    }
    fn request_origin(&self, headers: &HeaderMap, tunnel_origin: Option<&str>) -> Option<String> {
        if headers.get_all(header::HOST).iter().count() != 1 {
            return None;
        }
        let host = headers.get(header::HOST)?.to_str().ok()?;
        self.expected_origin(host, tunnel_origin)
    }
    fn accepts_headers(
        &self,
        headers: &HeaderMap,
        require_origin: bool,
        tunnel_origin: Option<&str>,
    ) -> bool {
        let Some(expected) = self.request_origin(headers, tunnel_origin) else {
            return false;
        };
        if headers.get_all(header::ORIGIN).iter().count() > 1 {
            return false;
        }
        match headers.get(header::ORIGIN) {
            Some(origin) => origin.to_str().ok() == Some(expected.as_str()),
            None => !require_origin,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    permissions: DevicePermissions,
    id: String,
    name: String,
    connected: bool,
    is_controller: bool,
    is_host: bool,
    #[serde(skip)]
    connection: u64,
    #[serde(skip)]
    auth_token: String,
    #[serde(skip)]
    local: bool,
    #[serde(skip)]
    origin: String,
    #[serde(skip)]
    supports_patches: bool,
}

struct Pairing {
    code: String,
    invite: String,
    origin: String,
    issuer_token: String,
    credential_created: Option<Instant>,
    expires: Instant,
    attempts: u8,
}

struct AttachedProject {
    controller_id: Option<String>,
    root: PathBuf,
    workspace: Option<workspace::Workspace>,
    terminal: Option<Arc<terminal::Terminal>>,
    ai: Option<ai::AiManager>,
    ai_context: Option<AiContext>,
}

#[derive(Clone)]
struct ProjectView {
    project_id: String,
    generation: u64,
}

struct Session {
    access: AccessPolicy,
    projects: BTreeMap<String, AttachedProject>,
    views: BTreeMap<String, ProjectView>,
    primary_attached: bool,
    workspace: workspace::Workspace,
    session_id: String,
    controller_id: Option<String>,
    generation: u64,
    clients: BTreeMap<String, Client>,
    pairing: Option<Pairing>,
    tokens: BTreeMap<String, auth::TokenRecord>,
    ai_context: Option<AiContext>,
}

#[derive(Clone, Serialize)]
struct AiContext {
    path: String,
    revision: u64,
}

impl Session {
    fn permissions_for_token(&self, token: &str) -> DevicePermissions {
        match auth::lookup(&self.tokens, token) {
            Some((_, record)) if record.is_host => DevicePermissions::FULL,
            Some((_, record)) if self.access.settings.allow_devices => record
                .permissions
                .intersect(self.access.settings.permissions),
            _ => DevicePermissions::NONE,
        }
    }
    fn permissions_for(&self, client: &str) -> DevicePermissions {
        self.clients
            .get(client)
            .map_or(DevicePermissions::NONE, |client| {
                self.permissions_for_token(&client.auth_token)
            })
    }
    fn is_host(&self, client: &str) -> bool {
        self.clients.get(client).is_some_and(|client| {
            auth::lookup(&self.tokens, &client.auth_token).is_some_and(|(_, record)| record.is_host)
        })
    }
    fn require_host(&self, client: &str) -> protocol::Result<()> {
        if self.is_host(client) {
            Ok(())
        } else {
            Err(Error::new(
                "permission_denied",
                "Only the PC host can change session access or host settings",
            ))
        }
    }
    fn authorize_command(&self, client: &str, command: &Command) -> protocol::Result<()> {
        use Command::*;
        let permissions = self.permissions_for(client);
        match command {
            SessionAccessSet { .. }
            | DevicePermissionsSet { .. }
            | PairCreate { .. }
            | RevokeAllDevices { .. }
            | InternetStart { .. }
            | InternetStop { .. }
            | OpenProject { .. }
            | AddProject { .. }
            | RemoveProject { .. }
            | BrowseProject { .. }
            | AiSettingsSet { .. }
            | AiAuthRefresh { .. } => return self.require_host(client),
            RevokeDevice {
                target_client_id, ..
            } if !self.is_host(client) => {
                let own = self
                    .clients
                    .get(client)
                    .zip(self.clients.get(target_client_id))
                    .is_some_and(|(own, target)| {
                        auth::secret_eq(&own.auth_token, &target.auth_token)
                    });
                if !own {
                    return self.require_host(client);
                }
            }
            CreateFile { .. }
            | EditFile { .. }
            | PatchFile { .. }
            | UndoFile { .. }
            | RedoFile { .. }
            | SaveFile { .. }
            | ResolveConflict { .. }
            | CloseFile { discard: true, .. }
                if !permissions.edit_files =>
            {
                return Err(Error::new(
                    "permission_denied",
                    "Editing files in the editor is disabled for this device",
                ));
            }
            ClaimControl
            | RequestControl
            | ReleaseControl { .. }
            | HandoffControl { .. }
            | TerminalStart { .. }
            | TerminalInput { .. }
            | TerminalResize { .. }
            | TerminalStop { .. }
            | TerminalHistory { .. }
                if !permissions.terminal =>
            {
                return Err(Error::new(
                    "permission_denied",
                    "Terminal access is disabled for this device",
                ));
            }
            AiStatus | AiSettingsGet | AiStart { .. } | AiApprove { .. } | AiCancel { .. }
                if !permissions.ai =>
            {
                return Err(Error::new(
                    "permission_denied",
                    "AI access is disabled for this device",
                ));
            }
            _ => {}
        }
        if (matches!(command, AiStart { .. })
            || matches!(command, AiApprove { choice, .. } if ai::approval_grants_permission(choice)))
            && (!permissions.edit_files || !permissions.terminal)
        {
            return Err(Error::new(
                "permission_denied",
                "Running AI tools requires editor, terminal and AI permissions",
            ));
        }
        Ok(())
    }
    fn personalize_access(&self, value: &mut Value, token: &str) {
        let permissions = self.permissions_for_token(token);
        value["permissions"] = json!(permissions);
        value["isHost"] =
            json!(auth::lookup(&self.tokens, token).is_some_and(|(_, record)| record.is_host));
        value["accessSettings"] = self.access.public_view();
        if value["type"] == "bootstrap" {
            if !permissions.terminal {
                value["terminal"] = json!(terminal::TerminalSnapshot::idle());
            }
            if !permissions.ai {
                value["ai"] = json!(ai::AiSnapshot::default());
                value["aiContext"] = Value::Null;
                value["providers"] = json!([]);
                value["aiSettings"] = Value::Null;
                value["settingsError"] = Value::Null;
            }
        }
    }
    fn primary_id(&self) -> String {
        workspace::recovery_id(&self.workspace.root)
    }
    fn default_project(&self) -> String {
        if self.primary_attached {
            self.primary_id()
        } else {
            self.projects
                .keys()
                .next()
                .cloned()
                .unwrap_or_else(|| self.primary_id())
        }
    }
    fn controller_for(&self, project_id: &str) -> Option<&str> {
        if project_id == self.primary_id() {
            self.controller_id.as_deref()
        } else {
            self.projects
                .get(project_id)
                .and_then(|project| project.controller_id.as_deref())
        }
    }
    fn set_controller(&mut self, project_id: &str, client: Option<String>) {
        if project_id == self.primary_id() {
            self.controller_id = client;
        } else if let Some(project) = self.projects.get_mut(project_id) {
            project.controller_id = client;
        }
    }
    fn selected_project(&self, client: Option<&str>) -> String {
        client
            .and_then(|client| self.views.get(client))
            .map(|view| view.project_id.clone())
            .unwrap_or_else(|| self.default_project())
    }
    fn client_generation(&self, client: Option<&str>) -> u64 {
        client
            .and_then(|client| self.views.get(client))
            .map_or(self.generation, |view| view.generation)
    }
    fn root_for(&self, project_id: &str) -> protocol::Result<&Path> {
        if project_id == self.primary_id() && self.primary_attached {
            Ok(&self.workspace.root)
        } else {
            self.projects
                .get(project_id)
                .map(|project| project.root.as_path())
                .ok_or_else(|| Error::new("project", "This project is no longer attached"))
        }
    }
    fn workspace_for(&self, project_id: &str) -> protocol::Result<&workspace::Workspace> {
        if project_id == self.primary_id() && self.primary_attached {
            Ok(&self.workspace)
        } else {
            self.projects
                .get(project_id)
                .and_then(|project| project.workspace.as_ref())
                .ok_or_else(|| {
                    Error::new("project", "Select this project before opening its files")
                })
        }
    }
    fn workspace_for_mut(
        &mut self,
        project_id: &str,
    ) -> protocol::Result<&mut workspace::Workspace> {
        if project_id == self.primary_id() && self.primary_attached {
            Ok(&mut self.workspace)
        } else {
            self.projects
                .get_mut(project_id)
                .and_then(|project| project.workspace.as_mut())
                .ok_or_else(|| {
                    Error::new("project", "Select this project before opening its files")
                })
        }
    }
    fn context_for(&self, project_id: &str) -> Option<AiContext> {
        if project_id == self.primary_id() {
            self.ai_context.clone()
        } else {
            self.projects
                .get(project_id)
                .and_then(|project| project.ai_context.clone())
        }
    }
    fn set_context(&mut self, project_id: &str, context: Option<AiContext>) {
        if project_id == self.primary_id() {
            self.ai_context = context;
        } else if let Some(project) = self.projects.get_mut(project_id) {
            project.ai_context = context;
        }
    }
    fn roots(&self) -> Vec<PathBuf> {
        let mut roots =
            Vec::with_capacity(self.projects.len() + usize::from(self.primary_attached));
        if self.primary_attached {
            roots.push(self.workspace.root.clone());
        }
        roots.extend(self.projects.values().map(|project| project.root.clone()));
        roots
    }
    fn project_views(&self) -> Vec<Value> {
        self.roots()
            .into_iter()
            .map(|root| {
                json!({"id":workspace::recovery_id(&root),
            "name":root.file_name().unwrap_or(root.as_os_str()).to_string_lossy(),"path":root})
            })
            .collect()
    }
    fn usage_except(&self, project_id: &str) -> (usize, usize, usize) {
        let mut usage = if self.primary_id() != project_id {
            self.workspace.usage()
        } else {
            (0, 0, 0)
        };
        for (id, project) in &self.projects {
            if id != project_id
                && let Some(workspace) = &project.workspace
            {
                let other = workspace.usage();
                usage.0 += other.0;
                usage.1 += other.1;
                usage.2 += other.2;
            }
        }
        usage
    }
    fn budget_workspace(&mut self, project_id: &str) -> protocol::Result<()> {
        let others = self.usage_except(project_id);
        self.workspace_for_mut(project_id)?.session_budget(
            workspace::MAX_OPEN.saturating_sub(others.0),
            workspace::MAX_HISTORY.saturating_sub(others.2),
        );
        Ok(())
    }
    fn authorize_connection(&self, client: &str, connection: u64) -> protocol::Result<()> {
        self.authorize_connection_at(client, connection, Instant::now())
    }
    fn authorize_connection_at(
        &self,
        client: &str,
        connection: u64,
        now: Instant,
    ) -> protocol::Result<()> {
        let Some(entry) = self
            .clients
            .get(client)
            .filter(|entry| entry.connected && entry.connection == connection)
        else {
            return Err(Error::new(
                "stale_generation",
                "This device connection was replaced or disconnected",
            ));
        };
        if !auth::lookup(&self.tokens, &entry.auth_token).is_some_and(|(_, token)| {
            token.valid(&entry.origin, now) && (token.is_host || self.access.settings.allow_devices)
        }) {
            return Err(Error::new(
                "auth",
                "This device is no longer paired with the host",
            ));
        }
        Ok(())
    }
    fn authorize_project(&self, client: &str, project_id: Option<&str>) -> protocol::Result<()> {
        if project_id.is_some_and(|id| id != self.selected_project(Some(client))) {
            return Err(Error::new(
                "stale_project",
                "The selected project changed; refresh before sending this command",
            ));
        }
        Ok(())
    }
    fn authorize(&self, client: &str, connection: u64, generation: u64) -> protocol::Result<()> {
        self.authorize_connection(client, connection)?;
        if self.client_generation(Some(client)) != generation {
            return Err(Error::new(
                "stale_generation",
                "The project changed; reload the current session before sending more changes",
            ));
        }
        Ok(())
    }
    fn touch(&mut self, client: &str, connection: u64, now: Instant) -> protocol::Result<()> {
        self.authorize_connection_at(client, connection, now)?;
        let token = self.clients.get(client).unwrap().auth_token.clone();
        self.tokens.get_mut(&token).unwrap().last_activity = now;
        Ok(())
    }
    fn prune_expired(&mut self, now: Instant) -> bool {
        let before = self.tokens.len();
        self.tokens.retain(|_, record| !record.expired(now));
        if self.tokens.len() == before {
            return false;
        }
        self.remove_unpaired_clients();
        true
    }
    fn remove_unpaired_clients(&mut self) {
        self.clients
            .retain(|_, client| self.tokens.contains_key(&client.auth_token));
        self.views.retain(|id, _| self.clients.contains_key(id));
        for project in self.projects.values_mut() {
            if project
                .controller_id
                .as_ref()
                .is_some_and(|id| !self.clients.contains_key(id))
            {
                project.controller_id = None;
            }
        }
        if self
            .controller_id
            .as_ref()
            .is_some_and(|id| !self.clients.contains_key(id))
        {
            self.controller_id = None;
        }
    }
    fn control(&self) -> Value {
        json!({"type":"control","access":"shared","controllerId":self.controller_id,"generation":self.generation,"clients":self.client_views(),"pairedSessions":self.tokens.values().filter(|token| !token.is_host).count(),"accessSettings":self.access.public_view()})
    }
    fn client_views(&self) -> Vec<Client> {
        self.clients
            .values()
            .map(|client| {
                let mut view = client.clone();
                view.is_controller = self.controller_id.as_deref() == Some(client.id.as_str());
                view.is_host = self.is_host(&client.id);
                view.permissions = self.permissions_for(&client.id);
                view
            })
            .collect()
    }
    fn claim(&mut self, client: &str, connection: u64) -> protocol::Result<()> {
        self.authorize_connection(client, connection)?;
        let project_id = self.selected_project(Some(client));
        if self.controller_for(&project_id) == Some(client) {
            return Ok(());
        }
        self.set_controller(&project_id, Some(client.into()));
        Ok(())
    }
}

struct App {
    config: Config,
    remote: remote::RemoteManager,
    session: Mutex<Session>,
    events: broadcast::Sender<Arc<Value>>,
    terminal: Arc<terminal::Terminal>,
    ai: ai::AiManager,
    ai_changed: watch::Sender<u64>,
    auth_changed: watch::Sender<u64>,
    connections: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
    folder_picker: Mutex<bool>,
    pc_recovery: browser::Recovery,
}

impl App {
    fn local_pc_origin(
        &self,
        headers: &HeaderMap,
        remote: SocketAddr,
        require_origin: bool,
    ) -> Option<String> {
        self.local_pc_authority(headers, remote, require_origin)
            .map(|_| self.config.pc_origin())
    }
    fn local_pc_authority(
        &self,
        headers: &HeaderMap,
        remote: SocketAddr,
        require_origin: bool,
    ) -> Option<String> {
        if !remote.ip().is_loopback() || !self.config.local_headers(headers) {
            return None;
        }
        self.accepted_origin(headers, require_origin)
            .filter(|origin| origin.starts_with("http://"))
    }
    fn private_pc_link(&self, origin: &str) -> Option<String> {
        let session = self.session.lock().unwrap();
        session
            .tokens
            .iter()
            .find(|(_, token)| token.is_host)
            .map(|(token, _)| format!("{origin}/#token={token}"))
    }
    async fn open_pc_browser<F, Fut>(
        &self,
        origin: &str,
        opener: F,
    ) -> Result<(), browser::OpenError>
    where
        F: FnOnce(String, watch::Receiver<bool>) -> Fut,
        Fut: std::future::Future<Output = Result<(), browser::OpenError>>,
    {
        if *self.shutdown.borrow() {
            return Err(browser::OpenError::ShuttingDown);
        }
        let _permit = self.pc_recovery.begin(Instant::now())?;
        let link = self
            .private_pc_link(origin)
            .ok_or(browser::OpenError::Failed)?;
        opener(link, self.shutdown.subscribe()).await
    }
    fn restore_projects(&self) -> protocol::Result<()> {
        let Some(path) = self.config.projects_path() else {
            return Ok(());
        };
        let roots = projects::load(&path).map_err(Error::io)?;
        let mut session = self.session.lock().unwrap();
        for root in roots {
            let id = workspace::recovery_id(&root);
            if id == session.primary_id() || session.projects.contains_key(&id) {
                continue;
            }
            // An explicit --workspace always gets one of the bounded slots.
            if session.projects.len() + 1 >= projects::MAX_PROJECTS {
                break;
            }
            session.projects.insert(
                id,
                AttachedProject {
                    controller_id: None,
                    root,
                    workspace: None,
                    terminal: None,
                    ai: None,
                    ai_context: None,
                },
            );
        }
        Ok(())
    }
    fn scoped_broadcast(&self, project_id: &str, mut event: Value) {
        event["projectId"] = json!(project_id);
        self.broadcast(event);
    }
    fn terminal_for(&self, session: &Session, project_id: &str) -> Option<Arc<terminal::Terminal>> {
        if project_id == session.primary_id() {
            Some(self.terminal.clone())
        } else {
            session
                .projects
                .get(project_id)
                .and_then(|project| project.terminal.clone())
        }
    }
    fn ai_for(&self, session: &Session, project_id: &str) -> Option<ai::AiManager> {
        if project_id == session.primary_id() {
            Some(self.ai.clone())
        } else {
            session
                .projects
                .get(project_id)
                .and_then(|project| project.ai.clone())
        }
    }
    fn terminal_snapshot(&self, session: &Session, project_id: &str) -> terminal::TerminalSnapshot {
        self.terminal_for(session, project_id)
            .map_or_else(terminal::TerminalSnapshot::idle, |terminal| {
                terminal.snapshot()
            })
    }
    fn ai_snapshot(&self, session: &Session, project_id: &str) -> ai::AiSnapshot {
        self.ai_for(session, project_id)
            .map_or_else(ai::AiSnapshot::default, |ai| ai.snapshot())
    }
    fn ensure_project_workspace(
        &self,
        session: &mut Session,
        project_id: &str,
    ) -> protocol::Result<()> {
        if project_id == session.primary_id() && session.primary_attached {
            if !session.workspace.is_attached() {
                let root = session.workspace.root.clone();
                if std::fs::canonicalize(&root).map_err(Error::io)? != root {
                    return Err(Error::new(
                        "path",
                        "This project folder changed; add its intended folder instead",
                    ));
                }
                let others = session.usage_except(project_id);
                let mut restored = workspace::Workspace::new_with_budget(
                    &root,
                    self.config.project_state(&root),
                    workspace::MAX_OPEN.saturating_sub(others.0),
                )?;
                if restored.root != root {
                    return Err(Error::new(
                        "path",
                        "The project folder changed while opening",
                    ));
                }
                restored.list("")?;
                restored.session_budget(
                    workspace::MAX_OPEN.saturating_sub(others.0),
                    workspace::MAX_HISTORY.saturating_sub(others.2),
                );
                session.workspace = restored;
            }
            return session.budget_workspace(project_id);
        }
        let project = session
            .projects
            .get(project_id)
            .ok_or_else(|| Error::new("project", "This project is no longer attached"))?;
        if project.workspace.is_none() {
            let root = project.root.clone();
            if std::fs::canonicalize(&root).map_err(Error::io)? != root {
                return Err(Error::new(
                    "path",
                    "This project folder moved or became a symlink; remove it and add the intended folder again",
                ));
            }
            let others = session.usage_except(project_id);
            let mut next = workspace::Workspace::new_with_budget(
                &root,
                self.config.project_state(&root),
                workspace::MAX_OPEN.saturating_sub(others.0),
            )?;
            if next.root != root {
                return Err(Error::new(
                    "path",
                    "The project folder changed while it was opening",
                ));
            }
            next.list("")?;
            let usage = next.usage();
            if usage.0 + others.0 > workspace::MAX_OPEN
                || usage.1 + others.1 > workspace::MAX_BUFFERS
            {
                return Err(Error::new(
                    "limit",
                    "Close files in another project before loading this project's recovered files",
                ));
            }
            next.session_budget(
                workspace::MAX_OPEN.saturating_sub(others.0),
                workspace::MAX_HISTORY.saturating_sub(others.2),
            );
            session.projects.get_mut(project_id).unwrap().workspace = Some(next);
        }
        session.budget_workspace(project_id)
    }
    fn ensure_project_ai(
        &self,
        session: &mut Session,
        project_id: &str,
    ) -> protocol::Result<ai::AiManager> {
        if let Some(ai) = self.ai_for(session, project_id) {
            return Ok(ai);
        }
        let root = session.root_for(project_id)?.to_owned();
        let changed = self.ai_changed.clone();
        let ai = self.ai.for_project(
            root,
            Arc::new(move || {
                changed.send_modify(|version| *version = version.wrapping_add(1));
            }),
        );
        session.projects.get_mut(project_id).unwrap().ai = Some(ai.clone());
        Ok(ai)
    }
    fn ensure_project_terminal(
        &self,
        session: &mut Session,
        project_id: &str,
    ) -> protocol::Result<Arc<terminal::Terminal>> {
        if let Some(terminal) = self.terminal_for(session, project_id) {
            return Ok(terminal);
        }
        let terminal = terminal::Terminal::new();
        session
            .projects
            .get_mut(project_id)
            .ok_or_else(|| Error::new("project", "This project is no longer attached"))?
            .terminal = Some(terminal.clone());
        Ok(terminal)
    }
    fn persist_projects(&self, session: &Session) -> protocol::Result<()> {
        if let Some(path) = self.config.projects_path() {
            projects::save(&path, session.roots()).map_err(Error::io)?;
        }
        Ok(())
    }
    fn select_project(
        &self,
        session: &mut Session,
        client: &str,
        project_id: &str,
    ) -> protocol::Result<Value> {
        session.root_for(project_id)?;
        self.ensure_project_workspace(session, project_id)?;
        let generation = session.client_generation(Some(client));
        if session.selected_project(Some(client)) != project_id {
            session.views.insert(
                client.to_owned(),
                ProjectView {
                    project_id: project_id.to_owned(),
                    generation: generation
                        .checked_add(1)
                        .ok_or_else(|| Error::new("limit", "Project generation exhausted"))?,
                },
            );
        }
        let root = session.root_for(project_id)?.to_owned();
        let preference_error = self.remember_project(&root);
        let mut snapshot = self.bootstrap_session(session, Some(client))?;
        snapshot["preferenceError"] = json!(preference_error);
        Ok(snapshot)
    }
    fn internet_snapshot(&self) -> Value {
        if let Some(origin) = self
            .config
            .origin
            .as_deref()
            .filter(|origin| origin.starts_with("https://"))
        {
            return json!({"status":"ready","url":origin,"error":null,"available":true,"managed":false});
        }
        let mut snapshot = serde_json::to_value(self.remote.snapshot()).unwrap();
        snapshot["managed"] = json!(true);
        snapshot
    }
    fn accepts_headers(&self, headers: &HeaderMap, require_origin: bool) -> bool {
        self.accepted_origin(headers, require_origin).is_some()
    }
    fn accepted_origin(&self, headers: &HeaderMap, require_origin: bool) -> Option<String> {
        let tunnel_origin = self.remote.origin();
        if !self
            .config
            .accepts_headers(headers, require_origin, tunnel_origin.as_deref())
        {
            return None;
        }
        self.config
            .request_origin(headers, tunnel_origin.as_deref())
    }
    fn accepts_host(&self, host: &str) -> bool {
        self.config
            .expected_origin(host, self.remote.origin().as_deref())
            .is_some()
    }
    fn remember_project(&self, root: &Path) -> Option<String> {
        if let Some(preference) = &self.config.project_preference
            && let Err(error) = write_project_preference(preference, root)
        {
            eprintln!(
                "Nimlo: project opened, but the last-project preference could not be saved: {error}"
            );
            return Some(format!(
                "The project opened, but its preference could not be saved: {error}"
            ));
        }
        None
    }
    fn remember_desktop_startup_project(&self) -> Option<String> {
        if self.config.desktop {
            self.remember_project(&self.config.workspace)
        } else {
            None
        }
    }
    fn broadcast(&self, event: Value) {
        let _ = self.events.send(Arc::new(event));
    }
    #[cfg(test)]
    fn bootstrap(&self, client_id: Option<&str>) -> protocol::Result<Value> {
        let session = self.session.lock().unwrap();
        self.bootstrap_session(&session, client_id)
    }
    fn resync_events(
        &self,
        client: &str,
        connection: u64,
    ) -> protocol::Result<(Value, broadcast::Receiver<Arc<Value>>)> {
        let session = self.session.lock().unwrap();
        session.authorize_connection(client, connection)?;
        // Session mutations publish while holding this mutex. A new subscription and
        // its snapshot therefore share one boundary, without an older queued prefix.
        let events = self.events.subscribe();
        let snapshot = self.bootstrap_session(&session, Some(client))?;
        Ok((snapshot, events))
    }
    fn correlated_bootstrap(
        &self,
        client: &str,
        connection: u64,
        mut response: Value,
    ) -> protocol::Result<(Value, broadcast::Receiver<Arc<Value>>)> {
        let request_id = response.get_mut("requestId").map(Value::take);
        let preference_error = response.get_mut("preferenceError").map(Value::take);
        // Release the old document copies before constructing the current view.
        drop(response);
        // A peer may have removed the selected project while this command's
        // queued events were draining. Its correlated reply must describe the
        // newest view and start after that snapshot's event boundary.
        let (mut snapshot, events) = self.resync_events(client, connection)?;
        if let Some(request_id) = request_id {
            snapshot["requestId"] = request_id;
        }
        if let Some(preference_error) = preference_error {
            snapshot["preferenceError"] = preference_error;
        }
        Ok((snapshot, events))
    }
    fn bootstrap_session(
        &self,
        session: &Session,
        client_id: Option<&str>,
    ) -> protocol::Result<Value> {
        let picker_available = cfg!(target_os = "macos")
            && client_id
                .and_then(|id| session.clients.get(id))
                .is_some_and(|client| client.local);
        let project_id = session.selected_project(client_id);
        self.bootstrap_project(session, client_id, &project_id, picker_available)
    }
    fn bootstrap_project(
        &self,
        session: &Session,
        client_id: Option<&str>,
        project_id: &str,
        picker_available: bool,
    ) -> protocol::Result<Value> {
        let workspace = session.workspace_for(project_id)?;
        let mut value = json!({"type":"bootstrap","access":"shared","clientId":client_id,"sessionId":session.session_id,
            "textPatchVersion":if client_id.and_then(|id| session.clients.get(id)).is_some_and(|client| client.supports_patches) {1} else {0},
            "projectId":project_id,"projects":session.project_views(),"workspace":workspace.name(),"workspacePath":workspace.root,
            "pickerAvailable":picker_available,"activePath":workspace.active_path,"controllerId":session.controller_for(project_id),
            "generation":session.client_generation(client_id),"clients":session.client_views(),
            "pairedSessions":session.tokens.values().filter(|token| !token.is_host).count(),"files":workspace.list("")?,
            "openFiles":workspace.documents(),"recentFiles":workspace.recent_files(),"terminal":self.terminal_snapshot(session,project_id),
            "ai":self.ai_snapshot(session,project_id),"aiContext":session.context_for(project_id),
            "providers":self.ai.providers(),"aiSettings":self.ai.settings(),"settingsError":self.ai.settings_error(),
            "internet":self.internet_snapshot(),"connectUrls":self.config.connect_urls,"lanUrls":self.config.connect_urls,
            "limits":{"maxProjects":projects::MAX_PROJECTS,"maxFileBytes":workspace::MAX_FILE,"maxOpenFiles":workspace::MAX_OPEN,"maxRecentFiles":workspace::MAX_RECENT_FILES,
            "maxBufferBytes":workspace::MAX_BUFFERS,"maxHistoryBytes":workspace::MAX_HISTORY}});
        if let Some(client) = client_id.and_then(|id| session.clients.get(id)) {
            session.personalize_access(&mut value, &client.auth_token);
        }
        Ok(value)
    }

    fn token(
        &self,
        headers: &HeaderMap,
        remote: SocketAddr,
        accepted_origin: &str,
    ) -> Option<String> {
        let cookie_name = if accepted_origin.starts_with("https://") {
            "__Host-nimlo_session="
        } else {
            "nimlo_session="
        };
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned)
            .or_else(|| {
                headers
                    .get(header::COOKIE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|cookies| {
                        cookies.split(';').find_map(|cookie| {
                            cookie.trim().strip_prefix(cookie_name).map(str::to_owned)
                        })
                    })
            })?;
        if self.token_valid(
            &self.session.lock().unwrap(),
            &token,
            headers,
            remote,
            accepted_origin,
        ) {
            Some(token)
        } else {
            None
        }
    }
    fn token_valid(
        &self,
        session: &Session,
        token: &str,
        headers: &HeaderMap,
        remote: SocketAddr,
        origin: &str,
    ) -> bool {
        auth::lookup(&session.tokens, token).is_some_and(|(_, record)| {
            record.valid(origin, Instant::now())
                && (record.is_host || session.access.settings.allow_devices)
                && (!record.is_host
                    || (remote.ip().is_loopback()
                        && self.config.local_headers(headers)
                        && origin.starts_with("http://")))
        })
    }
    fn notify_auth(&self) {
        self.auth_changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
    fn cookie(&self, token: &str, accepted_origin: &str) -> String {
        // Preserve the transport authority admitted for this request even if
        // its tunnel shuts down while the response is being prepared.
        let secure = accepted_origin.starts_with("https://");
        format!(
            "{}={token}; HttpOnly; SameSite=Strict; Path=/{}",
            if secure {
                "__Host-nimlo_session"
            } else {
                "nimlo_session"
            },
            if secure { "; Secure" } else { "" }
        )
    }
}

#[derive(Default, Deserialize)]
struct ConnectionQuery {
    patches: Option<u8>,
    #[serde(rename = "clientId")]
    client_id: Option<String>,
    name: Option<String>,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"type":"error","code":code,"message":message})),
    )
        .into_response()
}

fn protect(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
    response
}

async fn response_security(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let secure = app
        .accepted_origin(request.headers(), false)
        .is_some_and(|origin| origin.starts_with("https://"));
    let response = match tokio::time::timeout(Duration::from_secs(8), next.run(request)).await {
        Ok(response) => response,
        Err(_) => error_response(StatusCode::REQUEST_TIMEOUT, "timeout", "Request timed out"),
    };
    let mut response = protect(response);
    if secure {
        response.headers_mut().insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

async fn bootstrap(
    State(app): State<Arc<App>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ConnectionQuery>,
) -> Response {
    let Some(accepted_origin) = app.accepted_origin(&headers, false) else {
        return error_response(
            StatusCode::FORBIDDEN,
            "origin",
            "Host or Origin is not allowed",
        );
    };
    let Some(token) = app.token(&headers, remote, &accepted_origin) else {
        let mut error = json!({"type":"error","code":"auth","message":"Open the host's private launch link or pair this device"});
        error["passwordRequired"] =
            app.session.lock().unwrap().access.public_view()["passwordSet"].clone();
        if let Some(origin) = app.local_pc_origin(&headers, remote, false) {
            error["pcOrigin"] = json!(origin);
        }
        return (StatusCode::UNAUTHORIZED, Json(error)).into_response();
    };
    // Snapshot and second authorization share the session lock, so revocation
    // cannot win between the initial token check and reading private state.
    let result = {
        let mut session = app.session.lock().unwrap();
        if !app.token_valid(&session, &token, &headers, remote, &accepted_origin) {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "auth",
                "This session expired or was revoked",
            );
        }
        let client = query.client_id.as_deref().filter(|id| {
            session
                .clients
                .get(*id)
                .is_some_and(|client| auth::secret_eq(&client.auth_token, &token))
        });
        let result = if client.is_none()
            && let Some(project_id) = query
                .project_id
                .as_deref()
                .filter(|id| session.root_for(id).is_ok())
        {
            app.ensure_project_workspace(&mut session, project_id)
                .and_then(|()| app.bootstrap_project(&session, None, project_id, false))
        } else {
            app.bootstrap_session(&session, client)
        };
        result.map(|mut value| {
            // HTTP snapshots must use the credential even without a registered
            // clientId; otherwise omitting that query field bypasses redaction.
            session.personalize_access(&mut value, &token);
            value
        })
    };
    match result {
        Ok(value) => {
            let mut response = Json(value).into_response();
            response.headers_mut().insert(
                header::SET_COOKIE,
                HeaderValue::from_str(&app.cookie(&token, &accepted_origin)).unwrap(),
            );
            protect(response)
        }
        Err(error) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.code,
            &error.message,
        ),
    }
}

fn fetch_header_matches(headers: &HeaderMap, name: &str, required: bool, values: &[&str]) -> bool {
    let mut entries = headers.get_all(name).iter();
    match entries.next() {
        Some(value) => {
            entries.next().is_none()
                && value
                    .to_str()
                    .ok()
                    .is_some_and(|value| values.contains(&value))
        }
        None => !required,
    }
}

async fn pc_open(
    State(app): State<Arc<App>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    pc_open_using(&app, remote, &headers, browser::open_private_browser).await
}

async fn pc_open_using<F, Fut>(
    app: &App,
    remote: SocketAddr,
    headers: &HeaderMap,
    opener: F,
) -> Response
where
    F: FnOnce(String, watch::Receiver<bool>) -> Fut,
    Fut: std::future::Future<Output = Result<(), browser::OpenError>>,
{
    let Some(origin) = app.local_pc_authority(headers, remote, true) else {
        return error_response(
            StatusCode::FORBIDDEN,
            "pc_local_only",
            "Open the editor from its local PC page.",
        );
    };
    if !fetch_header_matches(headers, "x-nimlo-launch", true, &["1"])
        || !fetch_header_matches(headers, "sec-fetch-site", false, &["same-origin"])
        || !fetch_header_matches(headers, "sec-fetch-mode", false, &["cors", "same-origin"])
        || !fetch_header_matches(headers, "sec-fetch-dest", false, &["empty"])
        || headers.contains_key("sec-fetch-user")
    {
        return error_response(
            StatusCode::FORBIDDEN,
            "pc_local_only",
            "Open the editor using the button on its local PC page.",
        );
    }
    match app.open_pc_browser(&origin, opener).await {
        Ok(()) => {
            Json(json!({"opened":true,"message":"Opened the editor in your default browser."}))
                .into_response()
        }
        Err(error) => {
            let (status, code) = match error {
                browser::OpenError::Busy => (StatusCode::TOO_MANY_REQUESTS, "pc_open_busy"),
                browser::OpenError::RateLimited => {
                    (StatusCode::TOO_MANY_REQUESTS, "pc_open_rate_limit")
                }
                browser::OpenError::Failed => (StatusCode::SERVICE_UNAVAILABLE, "pc_open_failed"),
                browser::OpenError::TimedOut => (StatusCode::GATEWAY_TIMEOUT, "pc_open_timeout"),
                browser::OpenError::ShuttingDown => (StatusCode::SERVICE_UNAVAILABLE, "shutdown"),
            };
            error_response(status, code, error.message())
        }
    }
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    #[serde(default)]
    invite: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

async fn pair(
    State(app): State<Arc<App>>,
    ConnectInfo(_remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    let Some(accepted_origin) = app.accepted_origin(&headers, true) else {
        return error_response(
            StatusCode::FORBIDDEN,
            "origin",
            "Pair from this editor's own page",
        );
    };
    tokio::task::spawn_blocking(move || pair_session(&app, request, accepted_origin))
        .await
        .unwrap_or_else(|_| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Device pairing could not complete",
            )
        })
}

fn pair_session(app: &App, request: PairRequest, accepted_origin: String) -> Response {
    let mut session = app.session.lock().unwrap();
    let now = Instant::now();
    if !session.access.settings.allow_devices {
        return error_response(
            StatusCode::FORBIDDEN,
            "devices_disabled",
            "The PC host has disabled connected devices",
        );
    }
    // A guessed or absent capability never spends the legitimate invite's code
    // budget. Proxy peers do not share an IP-based lockout.
    if !session.pairing.as_ref().is_some_and(|pairing| {
        request
            .invite
            .as_deref()
            .is_some_and(|invite| auth::secret_eq(invite, &pairing.invite))
            && pairing.origin == accepted_origin
    }) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "pairing",
            "Pairing invitation is invalid or expired",
        );
    }
    if !session.pairing.as_ref().is_some_and(|pairing| {
        session
            .tokens
            .get(&pairing.issuer_token)
            .is_some_and(|record| !record.expired(now))
    }) {
        session.pairing = None;
        return error_response(
            StatusCode::UNAUTHORIZED,
            "pairing",
            "The inviting session expired or was revoked; request a new invitation on the PC",
        );
    }
    let code_valid = session.pairing.as_ref().is_some_and(|pairing| {
        pairing.expires > now
            && pairing.attempts < 5
            && request.code.len() == 6
            && bool::from(request.code.as_bytes().ct_eq(pairing.code.as_bytes()))
    });
    let password_required = session.access.public_view()["passwordSet"] == true;
    if code_valid && password_required && request.password.as_deref().is_none_or(str::is_empty) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "Enter the pairing password set by the PC host",
        );
    }
    let password_valid = code_valid
        && session
            .access
            .verify_password(request.password.as_deref().unwrap_or(""));
    let valid = if let Some(pairing) = session.pairing.as_mut() {
        pairing.attempts += 1;
        pairing.expires > Instant::now() && pairing.attempts <= 5 && password_valid
    } else {
        false
    };
    if !valid {
        if session
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.expires <= now || pairing.attempts >= 5)
        {
            session.pairing = None;
        }
        return error_response(
            StatusCode::UNAUTHORIZED,
            "pairing",
            "Pairing code or password is incorrect, or the invitation expired; request a new invitation on the PC",
        );
    }
    if session.prune_expired(now) {
        app.notify_auth();
        app.broadcast(session.control());
    }
    if session.tokens.len() >= MAX_TOKENS {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "limit",
            "Device limit reached; revoke an old device session and try again",
        );
    }
    let credential_created = session
        .pairing
        .take()
        .unwrap()
        .credential_created
        .unwrap_or(now);
    let token = secret();
    session.tokens.insert(
        token.clone(),
        auth::TokenRecord {
            created: credential_created,
            ..auth::TokenRecord::paired(accepted_origin.clone(), now)
        },
    );
    app.broadcast(json!({"type":"pairing_cancelled"}));
    app.broadcast(session.control());
    let mut response = Json(json!({"paired":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&app.cookie(&token, &accepted_origin)).unwrap(),
    );
    protect(response)
}

async fn websocket(
    State(app): State<Arc<App>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<ConnectionQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(accepted_origin) = app.accepted_origin(&headers, true) else {
        return error_response(
            StatusCode::FORBIDDEN,
            "origin",
            "WebSocket Origin is not allowed",
        );
    };
    let Some(token) = app.token(&headers, remote, &accepted_origin) else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "auth",
            "Pair or sign in to this host first",
        );
    };
    let Ok(permit) = app.connections.clone().try_acquire_owned() else {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "limit",
            "Too many connections; try again after a moment",
        );
    };
    let client = query.client_id.unwrap_or_else(secret);
    if client.len() > 80
        || client.len() < 8
        || !client
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "client",
            "Invalid device identifier",
        );
    }
    let name = query
        .name
        .unwrap_or_else(|| "Browser".into())
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect::<String>();
    let connection = rand::random::<u64>();
    {
        let mut session = app.session.lock().unwrap();
        if session.prune_expired(Instant::now()) {
            app.notify_auth();
            app.broadcast(session.control());
        }
        if !app.token_valid(&session, &token, &headers, remote, &accepted_origin) {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "auth",
                "This session expired or was revoked",
            );
        }
        if session
            .clients
            .get(&client)
            .is_some_and(|entry| entry.auth_token != token)
        {
            return error_response(
                StatusCode::FORBIDDEN,
                "client",
                "This device identifier belongs to another paired device",
            );
        }
        if session
            .clients
            .values()
            .filter(|client| client.connected)
            .count()
            >= MAX_CLIENTS
            && !session
                .clients
                .get(&client)
                .is_some_and(|entry| entry.connected)
        {
            return error_response(
                StatusCode::TOO_MANY_REQUESTS,
                "limit",
                "Eight devices are already connected",
            );
        }
        if session.clients.len() >= 32 && !session.clients.contains_key(&client) {
            let remove = session
                .clients
                .iter()
                .find(|(id, c)| {
                    !c.connected && session.controller_id.as_deref() != Some(id.as_str())
                })
                .map(|(id, _)| id.clone());
            if let Some(remove) = remove {
                session.clients.remove(&remove);
                session.views.remove(&remove);
                for project in session.projects.values_mut() {
                    if project.controller_id.as_deref() == Some(remove.as_str()) {
                        project.controller_id = None;
                    }
                }
            } else {
                return error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "limit",
                    "Device list is full",
                );
            }
        }
        let selected = session
            .views
            .get(&client)
            .map(|view| view.project_id.clone())
            .or_else(|| {
                query
                    .project_id
                    .as_ref()
                    .filter(|id| session.root_for(id).is_ok())
                    .cloned()
            })
            .unwrap_or_else(|| session.default_project());
        if let Err(error) = app.ensure_project_workspace(&mut session, &selected) {
            return error_response(StatusCode::BAD_REQUEST, error.code, &error.message);
        }
        if !session.views.contains_key(&client) && selected != session.default_project() {
            let generation = session.generation;
            session.views.insert(
                client.clone(),
                ProjectView {
                    project_id: selected,
                    generation,
                },
            );
        }
        let is_host = auth::lookup(&session.tokens, &token).unwrap().1.is_host;
        session.clients.insert(
            client.clone(),
            Client {
                permissions: DevicePermissions::FULL,
                supports_patches: query.patches == Some(1),
                id: client.clone(),
                name,
                connected: true,
                is_controller: false,
                is_host,
                connection,
                auth_token: token,
                local: remote.ip().is_loopback() && app.config.local_headers(&headers),
                origin: accepted_origin,
            },
        );
        if session.controller_id.is_none() {
            let _ = session.claim(&client, connection);
        }
        app.broadcast(session.control());
    }
    let failed_app = app.clone();
    let failed_client = client.clone();
    let host = headers[header::HOST].to_str().unwrap().to_owned();
    upgrade
        .on_failed_upgrade(move |_| disconnect(&failed_app, &failed_client, connection))
        .max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .write_buffer_size(16 * 1024)
        .max_write_buffer_size(64 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            socket_loop(app, socket, client, connection, host).await
        })
        .into_response()
}

async fn send(
    app: &App,
    socket: &mut WebSocket,
    client: &str,
    connection: u64,
    value: &Value,
) -> bool {
    let mut auth_changes = app.auth_changed.subscribe();
    let (permissions, personalized) = {
        let session = app.session.lock().unwrap();
        if session.authorize_connection(client, connection).is_err() {
            return false;
        }
        let permissions = session.permissions_for(client);
        let kind = value["type"].as_str().unwrap_or("");
        let private_result = (!permissions.terminal
            && matches!(kind, "terminal_state" | "terminal_history"))
            || (!permissions.ai && matches!(kind, "ai_state" | "ai_settings" | "provider_state"));
        if private_result && value.get("requestId").is_none() {
            return true; // Suppress shared streams this credential cannot read.
        }
        let personalized = if private_result {
            // Settle a command that completed just before access changed
            // without exposing its now-private result to the device.
            Some(
                json!({"type":"error", "code":"permission_denied", "requestId":value["requestId"],
                "message":"Device permissions changed before this command completed"}),
            )
        } else if matches!(kind, "control" | "bootstrap" | "session_access") {
            let mut result = value.clone();
            let token = &session.clients.get(client).unwrap().auth_token;
            session.personalize_access(&mut result, token);
            if kind == "control" {
                result["generation"] = json!(session.client_generation(Some(client)));
                let project_id = session.selected_project(Some(client));
                result["projectId"] = json!(project_id);
                result["controllerId"] = json!(session.controller_for(&project_id));
                // Queued controls must describe current rights after a change.
                result["clients"] = json!(session.client_views());
                result["pairedSessions"] = json!(
                    session
                        .tokens
                        .values()
                        .filter(|record| !record.is_host)
                        .count()
                );
            }
            Some(result)
        } else if kind == "file_patch"
            && !session
                .clients
                .get(client)
                .is_some_and(|client| client.supports_patches)
        {
            let project = value["projectId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| session.selected_project(Some(client)));
            let path = value["file"]["path"].as_str().unwrap_or("");
            let mut result = match session
                .workspace_for(&project)
                .and_then(|workspace| workspace.file_snapshot(path))
            {
                Ok(document) => {
                    json!({"type":"file_state","projectId":project,"sourceClientId":value["sourceClientId"],"file":document})
                }
                Err(_) => json!({"type":"file_closed","projectId":project,"path":path}),
            };
            if let Some(request) = value.get("requestId") {
                result["requestId"] = request.clone();
            }
            Some(result)
        } else {
            None
        };
        (permissions, personalized)
    };
    let Ok(text) = serde_json::to_string(personalized.as_ref().unwrap_or(value)) else {
        return false;
    };
    let still_authorized = || {
        let session = app.session.lock().unwrap();
        session.authorize_connection(client, connection).is_ok()
            && session.permissions_for(client) == permissions
    };
    if !still_authorized() {
        return false;
    }
    let sending = tokio::time::timeout(
        Duration::from_secs(3),
        socket.send(Message::Text(text.into())),
    );
    tokio::pin!(sending);
    loop {
        tokio::select! {
            biased;
            changed = auth_changes.changed() => {
                if changed.is_err() || !still_authorized() {
                    return false;
                }
            }
            result = &mut sending => return matches!(result, Ok(Ok(()))),
        }
    }
}

async fn resync_socket(
    app: &App,
    socket: &mut WebSocket,
    client: &str,
    connection: u64,
    events: &mut broadcast::Receiver<Arc<Value>>,
) -> bool {
    let Ok((snapshot, subscription)) = app.resync_events(client, connection) else {
        return false;
    };
    *events = subscription;
    send(app, socket, client, connection, &snapshot).await
}

async fn send_event(
    app: &App,
    socket: &mut WebSocket,
    client: &str,
    connection: u64,
    events: &mut broadcast::Receiver<Arc<Value>>,
    event: std::result::Result<Arc<Value>, broadcast::error::RecvError>,
) -> bool {
    match event {
        Ok(event) => {
            if let Some(project_id) = event["projectId"].as_str()
                && project_id != app.session.lock().unwrap().selected_project(Some(client))
            {
                return true;
            }
            if event["type"] == "project_changed" {
                if event["clientIds"]
                    .as_array()
                    .is_some_and(|ids| !ids.iter().any(|id| id == client))
                {
                    return true;
                }
                resync_socket(app, socket, client, connection, events).await
            } else {
                send(app, socket, client, connection, &event).await
            }
        }
        Err(broadcast::error::RecvError::Lagged(_)) => {
            resync_socket(app, socket, client, connection, events).await
        }
        Err(broadcast::error::RecvError::Closed) => false,
    }
}

async fn send_queued_events(
    app: &App,
    socket: &mut WebSocket,
    client: &str,
    connection: u64,
    events: &mut broadcast::Receiver<Arc<Value>>,
) -> bool {
    // A command publishes its authoritative event before returning. Send those
    // queued events before its correlated response, which is only an acknowledgement.
    // Continuous peer writers cannot keep this drain alive indefinitely.
    for _ in 0..16 {
        let event = match events.try_recv() {
            Ok(event) => Ok(event),
            Err(broadcast::error::TryRecvError::Lagged(count)) => {
                Err(broadcast::error::RecvError::Lagged(count))
            }
            Err(broadcast::error::TryRecvError::Empty) => return true,
            Err(broadcast::error::TryRecvError::Closed) => return false,
        };
        if !send_event(app, socket, client, connection, events, event).await {
            return false;
        }
    }
    // The cap may leave a command event behind ongoing peer activity. A fresh
    // atomic snapshot includes it and discards any now-obsolete queued events.
    resync_socket(app, socket, client, connection, events).await
}

async fn socket_loop(
    app: Arc<App>,
    mut socket: WebSocket,
    client: String,
    connection: u64,
    host: String,
) {
    let mut watched_terminal = {
        let session = app.session.lock().unwrap();
        app.terminal_for(&session, &session.selected_project(Some(&client)))
            .unwrap_or_else(|| app.terminal.clone())
    };
    let mut terminal_changes = watched_terminal.subscribe();
    let mut ai_changes = app.ai_changed.subscribe();
    let mut internet_changes = app.remote.subscribe();
    let mut shutdown = app.shutdown.subscribe();
    let mut auth_changes = app.auth_changed.subscribe();
    if *shutdown.borrow() || !app.accepts_host(&host) {
        disconnect(&app, &client, connection);
        return;
    }
    let Ok((bootstrap, mut events)) = app.resync_events(&client, connection) else {
        close_unauthorized(&mut socket).await;
        disconnect(&app, &client, connection);
        return;
    };
    if !send(&app, &mut socket, &client, connection, &bootstrap).await {
        if app
            .session
            .lock()
            .unwrap()
            .authorize_connection(&client, connection)
            .is_err()
        {
            close_unauthorized(&mut socket).await;
        }
        disconnect(&app, &client, connection);
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    let mut last_activity = Instant::now();
    let mut frame_window = Instant::now();
    let mut frame_count = 0usize;
    loop {
        tokio::select! {
            biased;
            _ = auth_changes.changed() => {
                if app.session.lock().unwrap().authorize_connection(&client, connection).is_err() { break; }
            }
            _ = shutdown.changed() => { let _ = tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Close(None))).await; break; }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if !app.accepts_host(&host) || app.session.lock().unwrap().authorize_connection(&client, connection).is_err() { break; }
                        last_activity = Instant::now();
                        if frame_window.elapsed() > Duration::from_secs(1) { frame_window = Instant::now(); frame_count = 0; }
                        frame_count += 1;
                        if frame_count > 60 { if !send(&app, &mut socket, &client, connection, &json!({"type":"error","code":"rate_limit","message":"Too many commands; wait a moment"})).await { break; } continue; }
                        let envelope = match serde_json::from_str::<Envelope>(&text) {
                            Ok(envelope) => envelope,
                            Err(error) => { if !send(&app, &mut socket, &client, connection, &json!({"type":"error","code":"protocol","message":error.to_string()})).await { break; } continue; }
                        };
                        if envelope.request_id.as_ref().is_some_and(|id| id.len() > 80) { break; }
                        let app_for_command = app.clone();
                        let client_for_command = client.clone();
                        let request_id = envelope.request_id.clone();
                        let dispatched = dispatch_scoped(app_for_command, client_for_command, connection, envelope.command, envelope.project_id);
                        tokio::pin!(dispatched);
                        let result = loop {
                            tokio::select! {
                                biased;
                                changed = auth_changes.changed() => {
                                    if changed.is_err() || app.session.lock().unwrap().authorize_connection(&client, connection).is_err() {
                                        break Err(Error::new("auth", "This session expired or was revoked"));
                                    }
                                }
                                result = &mut dispatched => break result,
                            }
                        };
                        last_activity = Instant::now();
                        let mut response = match result {
                            Ok(value) => value,
                            Err(error) => json!({"type":"error","code":error.code,"message":error.message}),
                        };
                        if let Some(request_id) = request_id { response["requestId"] = Value::String(request_id); }
                        if !send_queued_events(&app, &mut socket, &client, connection, &mut events).await { break; }
                        if response["type"] == "bootstrap" {
                            let Ok((snapshot, subscription)) = app.correlated_bootstrap(&client, connection, response) else { break; };
                            response = snapshot;
                            events = subscription;
                        }
                        if !send(&app, &mut socket, &client, connection, &response).await { break; }
                    }
                    Some(Ok(Message::Ping(data))) => { if app.session.lock().unwrap().authorize_connection(&client, connection).is_err() { break; } last_activity = Instant::now(); if !matches!(tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Pong(data))).await,Ok(Ok(()))) { break; } }
                    Some(Ok(Message::Pong(_))) => { last_activity = Instant::now(); }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => break,
                }
            }
            event = events.recv() => {
                if !send_event(&app, &mut socket, &client, connection, &mut events, event).await { break; }
            }
            changed = terminal_changes.changed() => {
                if changed.is_err() { break; }
                let event = { let session = app.session.lock().unwrap(); let project_id = session.selected_project(Some(&client));
                    json!({"type":"terminal_state","projectId":project_id,"terminal":app.terminal_snapshot(&session,&project_id)}) };
                if !send(&app, &mut socket, &client, connection, &event).await { break; }
            }
            changed = ai_changes.changed() => {
                if changed.is_err() { break; }
                let event = { let session = app.session.lock().unwrap(); let project_id = session.selected_project(Some(&client));
                    json!({"type":"ai_state","projectId":project_id,"ai":app.ai_snapshot(&session,&project_id),"aiContext":session.context_for(&project_id),"providers":app.ai.providers()}) };
                if !send(&app, &mut socket, &client, connection, &event).await { break; }
            }
            changed = internet_changes.changed() => {
                if changed.is_err() || !app.accepts_host(&host) { break; }
                if !send(&app, &mut socket, &client, connection, &json!({"type":"internet_state","internet":app.internet_snapshot()})).await { break; }
            }
            _ = heartbeat.tick() => {
                if app.session.lock().unwrap().authorize_connection(&client, connection).is_err() || last_activity.elapsed() > Duration::from_secs(65) { break; }
                if !matches!(tokio::time::timeout(Duration::from_secs(3), socket.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
            }
        }
        let selected_terminal = {
            let session = app.session.lock().unwrap();
            app.terminal_for(&session, &session.selected_project(Some(&client)))
                .unwrap_or_else(|| app.terminal.clone())
        };
        if !Arc::ptr_eq(&watched_terminal, &selected_terminal) {
            watched_terminal = selected_terminal;
            terminal_changes = watched_terminal.subscribe();
        }
        let valid = app
            .session
            .lock()
            .unwrap()
            .clients
            .get(&client)
            .is_some_and(|entry| entry.connection == connection);
        if !valid || !app.accepts_host(&host) {
            break;
        }
    }
    if app
        .session
        .lock()
        .unwrap()
        .authorize_connection(&client, connection)
        .is_err()
    {
        close_unauthorized(&mut socket).await;
    }
    disconnect(&app, &client, connection);
}

async fn close_unauthorized(socket: &mut WebSocket) {
    let _ = tokio::time::timeout(
        Duration::from_secs(3),
        socket.send(Message::Close(Some(CloseFrame {
            code: 1008,
            reason: "This session expired or was revoked".into(),
        }))),
    )
    .await;
}

fn disconnect(app: &App, client: &str, connection: u64) {
    let mut session = app.session.lock().unwrap();
    if let Some(entry) = session.clients.get_mut(client)
        && entry.connection == connection
    {
        entry.connected = false;
    }
    app.broadcast(session.control());
}

#[cfg(test)]
async fn dispatch(
    app: Arc<App>,
    client: String,
    connection: u64,
    command: Command,
) -> protocol::Result<Value> {
    dispatch_scoped(app, client, connection, command, None).await
}

async fn dispatch_scoped(
    app: Arc<App>,
    client: String,
    connection: u64,
    command: Command,
    project_id: Option<String>,
) -> protocol::Result<Value> {
    if let Command::InternetStart { generation } | Command::InternetStop { generation } = command {
        let authorize = || {
            if *app.shutdown.borrow() {
                return Err(Error::new("shutdown", "The host is shutting down"));
            }
            let session = app.session.lock().unwrap();
            session.authorize(&client, connection, generation)?;
            session.require_host(&client)?;
            session.authorize_project(&client, project_id.as_deref())
        };
        authorize()?;
        if app.config.dev_assets.is_some() && matches!(command, Command::InternetStart { .. }) {
            return Err(Error::new(
                "development_local",
                "Internet pairing is disabled in development. Run the regular desktop app to pair a phone.",
            ));
        }
        app.session
            .lock()
            .unwrap()
            .touch(&client, connection, Instant::now())?;
        if app
            .config
            .origin
            .as_deref()
            .is_some_and(|origin| origin.starts_with("https://"))
        {
            if matches!(command, Command::InternetStop { .. }) {
                return Err(Error::new(
                    "internet_managed",
                    "This internet link is managed outside Nimlo; stop its tunnel on the PC",
                ));
            }
        } else {
            // The manager rechecks after acquiring its operation lock. Session
            // authorization is synchronous, so no session lock crosses an await.
            let result = if matches!(command, Command::InternetStart { .. }) {
                app.remote
                    .start_if(|| authorize().map_err(|error| error.message))
                    .await
            } else {
                app.remote
                    .stop_if(|| authorize().map_err(|error| error.message))
                    .await
            };
            authorize()?;
            result.map_err(|message| Error::new("internet", message))?;
        }
        return Ok(json!({"type":"internet_state","internet":app.internet_snapshot()}));
    }
    tokio::task::spawn_blocking(move || {
        execute_scoped(&app, &client, connection, command, project_id.as_deref())
    })
    .await
    .map_err(|_| Error::new("internal", "Host command could not complete"))?
}

#[cfg(test)]
fn execute(app: &App, client: &str, connection: u64, command: Command) -> protocol::Result<Value> {
    execute_scoped(app, client, connection, command, None)
}

fn execute_scoped(
    app: &App,
    client: &str,
    connection: u64,
    command: Command,
    expected_project: Option<&str>,
) -> protocol::Result<Value> {
    let mut session = app.session.lock().unwrap();
    session.authorize_connection(client, connection)?;
    session.authorize_project(client, expected_project)?;
    let project_id = session.selected_project(Some(client));
    if let Some(generation) = command.generation() {
        session.authorize(client, connection, generation)?;
    }
    session.authorize_command(client, &command)?;
    if !matches!(command, Command::Ping) {
        session.touch(client, connection, Instant::now())?;
    }
    if let Command::SearchProjectFiles {
        target_project_id,
        query,
        cursor,
        generation,
    } = &command
    {
        let root = session.root_for(target_project_id)?.to_owned();
        drop(session);
        // execute_scoped already runs on spawn_blocking. Release the session
        // lock as well, so a name search cannot stall typing or other devices.
        let result = workspace::search_root_page(&root, query, cursor.clone())?;
        let session = app.session.lock().unwrap();
        session.authorize(client, connection, *generation)?;
        session.authorize_project(client, expected_project)?;
        session.authorize_command(client, &command)?;
        if session.root_for(target_project_id)? != root {
            return Err(Error::new(
                "project",
                "The project changed during the search",
            ));
        }
        return Ok(json!({"type":"project_file_search","projectId":project_id,
            "targetProjectId":target_project_id,"query":query,"files":result.files,
            "truncated":result.truncated,"cursor":result.cursor}));
    }
    if let Command::BrowseProject { generation } = &command {
        let generation = *generation;
        if !session.clients.get(client).is_some_and(|entry| entry.local) {
            return Err(Error::new(
                "picker_local_only",
                "Browse on PC is available from the editor's local PC page",
            ));
        }
        let root = session.root_for(&project_id)?.to_owned();
        {
            let mut picker = app.folder_picker.lock().unwrap();
            if *picker {
                return Err(Error::new(
                    "picker_busy",
                    "A folder picker is already open on the PC",
                ));
            }
            *picker = true;
        }
        drop(session);
        let selection = pick_project(&root, &app.shutdown);
        *app.folder_picker.lock().unwrap() = false;
        app.session
            .lock()
            .unwrap()
            .authorize(client, connection, generation)?;
        return Ok(json!({"type":"project_picked","path":selection?}));
    }
    session.budget_workspace(&project_id)?;
    let selects_file = matches!(
        &command,
        Command::OpenFile { .. } | Command::SelectFile { .. } | Command::CreateFile { .. }
    );
    let before_files = session
        .workspace_for(&project_id)
        .map(|workspace| (workspace.loaded_paths(), workspace.recent_files().to_vec()))
        .ok();
    let response = match command {
        Command::SessionAccessSet {
            settings, password, ..
        } => {
            let next = session.access.update(
                settings,
                password.as_deref(),
                app.config.access_settings_path().as_deref(),
            )?;
            let cancel_pairing = !next.settings.allow_devices || password.is_some();
            session.access = next;
            if !session.access.settings.allow_devices {
                session.tokens.retain(|_, record| record.is_host);
                session.remove_unpaired_clients();
            }
            if cancel_pairing {
                session.pairing = None;
                app.broadcast(json!({"type":"pairing_cancelled"}));
            }
            app.notify_auth();
            app.broadcast(session.control());
            json!({"type":"session_access","accessSettings":session.access.public_view()})
        }
        Command::DevicePermissionsSet {
            target_client_id,
            permissions,
            ..
        } => {
            let token = session
                .clients
                .get(&target_client_id)
                .ok_or_else(|| Error::new("device", "The target device session was not found"))?
                .auth_token
                .clone();
            let record = session
                .tokens
                .get_mut(&token)
                .ok_or_else(|| Error::new("device", "This device is no longer paired"))?;
            if record.is_host {
                return Err(Error::new(
                    "host_session",
                    "The PC host always has full access",
                ));
            }
            record.permissions = permissions;
            app.notify_auth();
            let control = session.control();
            app.broadcast(control.clone());
            control
        }
        Command::InternetStart { .. } | Command::InternetStop { .. } => {
            return Err(Error::new(
                "protocol",
                "Internet commands require asynchronous dispatch",
            ));
        }
        Command::ClaimControl => {
            session.claim(client, connection)?;
            let control = session.control();
            app.broadcast(control.clone());
            control
        }
        Command::RequestControl => {
            session.claim(client, connection)?;
            let control = session.control();
            app.broadcast(control.clone());
            control
        }
        Command::ReleaseControl { .. } => {
            if session.controller_for(&project_id) == Some(client) {
                session.set_controller(&project_id, None);
            }
            let control = session.control();
            app.broadcast(control.clone());
            control
        }
        Command::HandoffControl {
            target_client_id, ..
        } => {
            if !session
                .clients
                .get(&target_client_id)
                .is_some_and(|target| {
                    target.connected
                        && auth::lookup(&session.tokens, &target.auth_token)
                            .is_some_and(|(_, token)| token.valid(&target.origin, Instant::now()))
                })
            {
                return Err(Error::new("device", "The target device is not connected"));
            }
            session.set_controller(&project_id, Some(target_client_id));
            let control = session.control();
            app.broadcast(control.clone());
            control
        }
        Command::AddProject { path, .. } => {
            if path.len() > 4096 || path.contains('\0') || !Path::new(&path).is_absolute() {
                return Err(Error::new(
                    "path",
                    "Enter an absolute project folder path on the host PC",
                ));
            }
            let root = std::fs::canonicalize(path).map_err(|error| {
                Error::new(
                    "workspace",
                    format!("Cannot open this project folder: {error}"),
                )
            })?;
            if !root.is_dir() {
                return Err(Error::new(
                    "workspace",
                    "The project must be an existing folder",
                ));
            }
            let id = workspace::recovery_id(&root);
            let already_attached = session.root_for(&id).is_ok();
            if !already_attached {
                if session.roots().len() >= projects::MAX_PROJECTS {
                    return Err(Error::new(
                        "limit",
                        "Remove a project before attaching more than 32",
                    ));
                }
                if id == session.primary_id() {
                    session.primary_attached = true;
                } else {
                    session.projects.insert(
                        id.clone(),
                        AttachedProject {
                            controller_id: None,
                            root,
                            workspace: None,
                            terminal: None,
                            ai: None,
                            ai_context: None,
                        },
                    );
                }
                let result = app
                    .ensure_project_workspace(&mut session, &id)
                    .and_then(|()| app.persist_projects(&session));
                if let Err(error) = result {
                    if id == session.primary_id() {
                        session.primary_attached = false;
                    } else {
                        session.projects.remove(&id);
                    }
                    return Err(error);
                }
                app.broadcast(
                    json!({"type":"projects_changed","projects":session.project_views()}),
                );
            }
            app.select_project(&mut session, client, &id)?
        }
        Command::SelectProject {
            target_project_id, ..
        } => app.select_project(&mut session, client, &target_project_id)?,
        Command::RemoveProject {
            target_project_id, ..
        } => {
            session.root_for(&target_project_id)?;
            if session.roots().len() == 1 {
                return Err(Error::new(
                    "last_project",
                    "Keep at least one project attached",
                ));
            }
            let dirty = session
                .workspace_for(&target_project_id)
                .is_ok_and(workspace::Workspace::has_unsaved);
            if dirty {
                return Err(Error::new(
                    "unsaved",
                    "Save or discard this project's changes before removing it",
                ));
            }
            if app.terminal_snapshot(&session, &target_project_id).running {
                return Err(Error::new(
                    "busy_terminal",
                    "Stop this project's terminal before removing it",
                ));
            }
            if app
                .ai_for(&session, &target_project_id)
                .is_some_and(|ai| ai.is_busy())
            {
                return Err(Error::new(
                    "busy_ai",
                    "Finish or cancel this project's AI job before removing it",
                ));
            }
            let next_id = session
                .roots()
                .iter()
                .map(|root| workspace::recovery_id(root))
                .find(|id| id != &target_project_id)
                .unwrap();
            let pending_workspace = if session.workspace_for(&next_id).is_err() {
                let removed_usage = session
                    .workspace_for(&target_project_id)
                    .map(workspace::Workspace::usage)
                    .unwrap_or((0, 0, 0));
                let others = session.usage_except(&next_id);
                let root = session.root_for(&next_id)?.to_owned();
                if std::fs::canonicalize(&root).map_err(Error::io)? != root {
                    return Err(Error::new("path", "The fallback project folder changed"));
                }
                let mut workspace = workspace::Workspace::new_with_budget(
                    &root,
                    app.config.project_state(&root),
                    workspace::MAX_OPEN.saturating_sub(others.0.saturating_sub(removed_usage.0)),
                )?;
                if workspace.root != root {
                    return Err(Error::new(
                        "path",
                        "The fallback project changed while opening",
                    ));
                }
                workspace.list("")?;
                workspace.session_budget(
                    workspace::MAX_OPEN.saturating_sub(others.0.saturating_sub(removed_usage.0)),
                    workspace::MAX_HISTORY.saturating_sub(others.2.saturating_sub(removed_usage.2)),
                );
                Some(workspace)
            } else {
                None
            };
            if let Some(path) = app.config.projects_path() {
                projects::save(
                    &path,
                    session
                        .roots()
                        .into_iter()
                        .filter(|root| workspace::recovery_id(root) != target_project_id)
                        .collect(),
                )
                .map_err(Error::io)?;
            }
            if let Some(workspace) = pending_workspace {
                session.projects.get_mut(&next_id).unwrap().workspace = Some(workspace);
            }
            if target_project_id == session.primary_id() {
                session.workspace.release_clean_documents()?;
            }
            let affected: Vec<String> = session
                .clients
                .keys()
                .filter(|id| session.selected_project(Some(id)) == target_project_id)
                .cloned()
                .collect();
            if target_project_id == session.primary_id() {
                app.terminal.reset();
                session.ai_context = None;
                session.primary_attached = false;
            } else {
                session.projects.remove(&target_project_id);
            }
            for id in &affected {
                let generation = session.client_generation(Some(id)).wrapping_add(1);
                session.views.insert(
                    id.clone(),
                    ProjectView {
                        project_id: next_id.clone(),
                        generation,
                    },
                );
            }
            let _ = app.remember_project(session.root_for(&next_id)?);
            app.broadcast(json!({"type":"projects_changed","projects":session.project_views()}));
            if !affected.is_empty() {
                app.broadcast(json!({"type":"project_changed","clientIds":affected}));
            }
            app.bootstrap_session(&session, Some(client))?
        }
        Command::OpenProject { path, .. } => {
            if !session.projects.is_empty()
                || !session.views.is_empty()
                || !session.primary_attached
            {
                return Err(Error::new(
                    "multi_project",
                    "Use Add project or the project switcher while multiple projects are attached",
                ));
            }
            if path.len() > 4096 || path.contains('\0') || !Path::new(&path).is_absolute() {
                return Err(Error::new(
                    "path",
                    "Enter an absolute project folder path on the host PC",
                ));
            }
            let root = std::fs::canonicalize(&path).map_err(|error| {
                Error::new(
                    "workspace",
                    format!("Cannot open this project folder: {error}"),
                )
            })?;
            if !root.is_dir() {
                return Err(Error::new(
                    "workspace",
                    "The project must be an existing folder",
                ));
            }
            if root == session.workspace.root {
                let preference_error = app.remember_project(&root);
                return Ok(
                    json!({"type":"project_opened","workspacePath":root,"sessionId":session.session_id,"generation":session.generation,"unchanged":true,"preferenceError":preference_error}),
                );
            }
            for document in session.workspace.refresh()? {
                app.broadcast(json!({"type":"file_state","file":document}));
            }
            if session.workspace.has_unsaved() {
                return Err(Error::new(
                    "unsaved",
                    "Save all changed files and resolve disk conflicts before opening another project",
                ));
            }
            if app.ai.is_busy() {
                return Err(Error::new(
                    "busy_ai",
                    "Finish or cancel the AI job before opening another project",
                ));
            }
            let next = workspace::Workspace::new(&root, app.config.project_state(&root))?;
            next.list("")?;
            app.ai
                .switch_workspace(root.clone())
                .map_err(|message| Error::new("busy_ai", message))?;
            app.terminal.reset();
            session.workspace = next;
            session.ai_context = None;
            session.session_id = secret();
            session.generation = session.generation.wrapping_add(1);
            let preference_error = app.remember_project(&root);
            app.broadcast(json!({"type":"project_changed"}));
            json!({"type":"project_opened","workspacePath":root,"sessionId":session.session_id,"generation":session.generation,"preferenceError":preference_error})
        }
        Command::BrowseProject { .. } => {
            unreachable!("Folder picker is handled without holding the session lock")
        }
        Command::SearchProjectFiles { .. } => {
            unreachable!("File name search is handled without holding the session lock")
        }
        Command::ListProjectFiles {
            target_project_id,
            directory,
            ..
        } => {
            json!({"type":"project_files","projectId":project_id,"targetProjectId":target_project_id,
                "directory":directory,"files":workspace::list_root(session.root_for(&target_project_id)?, &directory)?})
        }
        Command::ListFiles { directory } => {
            json!({"type":"files","directory":directory,"files":session.workspace_for_mut(&project_id)?.list(&directory)?})
        }
        Command::OpenFile { path, .. } => {
            let event = json!({"type":"file_state","file":session.workspace_for_mut(&project_id)?.open_selected(&path)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::SelectFile { path, .. } => {
            session.workspace_for_mut(&project_id)?.select(&path)?;
            app.scoped_broadcast(&project_id, json!({"type":"file_state","file":session.workspace_for(&project_id)?.document(&path)?}));
            let event = json!({"type":"active_file","path":path});
            event
        }
        Command::CreateFile { path, content, .. } => {
            let document = session
                .workspace_for_mut(&project_id)?
                .create_selected(&path, content)?;
            let event = json!({"type":"file_state","file":document});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::EditFile {
            path,
            base_revision,
            content,
            ..
        } => {
            let event = json!({"type":"file_state","sourceClientId":client,"file":session.workspace_for_mut(&project_id)?.edit(&path, base_revision, content)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::PatchFile {
            path,
            base_revision,
            start,
            delete_count,
            insert,
            ..
        } => {
            let document = session.workspace_for_mut(&project_id)?.patch(
                &path,
                base_revision,
                start,
                delete_count,
                insert.clone(),
            )?;
            let event = json!({"type":"file_patch","sourceClientId":client,"baseRevision":base_revision,
                "patch":{"start":start,"deleteCount":delete_count,"insert":insert},
                "file":{"path":document.path,"revision":document.revision,"dirty":document.dirty,"conflict":document.conflict}});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::FileSync { path, .. } => {
            json!({"type":"file_state","file":session.workspace_for(&project_id)?.file_snapshot(&path)?})
        }
        Command::UndoFile { path, revision, .. } => {
            let event = json!({"type":"file_state","file":session.workspace_for_mut(&project_id)?.undo(&path, revision, false)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::RedoFile { path, revision, .. } => {
            let event = json!({"type":"file_state","file":session.workspace_for_mut(&project_id)?.undo(&path, revision, true)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::SaveFile { path, revision, .. } => {
            let event = json!({"type":"file_state","file":session.workspace_for_mut(&project_id)?.save(&path, revision)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::CloseFile {
            path,
            discard,
            revision,
            ..
        } => {
            let shortcut_only = revision.is_none_or(|revision| revision == 0)
                && !discard
                && session.workspace_for(&project_id)?.document(&path).is_err()
                && session
                    .workspace_for(&project_id)?
                    .recent_files()
                    .contains(&path);
            if !shortcut_only && (discard || revision.is_some()) {
                let document = session.workspace_for_mut(&project_id)?.document(&path)?;
                if revision.is_some_and(|revision| revision != document.revision) {
                    return Err(Error::new(
                        "stale_revision",
                        "The file changed on another device; reload it before closing",
                    ));
                }
                if discard && revision.is_none() && (document.dirty || document.conflict.is_some())
                {
                    return Err(Error::new(
                        "revision_required",
                        "Confirm the current file revision before discarding unsaved work",
                    ));
                }
            }
            session
                .workspace_for_mut(&project_id)?
                .close(&path, discard)?;
            app.scoped_broadcast(&project_id, json!({"type":"active_file","path":session.workspace_for_mut(&project_id)?.active_path}));
            let event = json!({"type":"file_closed","path":path});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::ResolveConflict {
            path,
            revision,
            disk_revision,
            resolution,
            ..
        } => {
            let event = json!({"type":"file_state","file":session.workspace_for_mut(&project_id)?.resolve_conflict(&path, revision, &disk_revision, &resolution)?});
            app.scoped_broadcast(&project_id, event.clone());
            event
        }
        Command::PairCreate { origin, .. } => {
            if !session.access.settings.allow_devices {
                return Err(Error::new(
                    "devices_disabled",
                    "Enable connected devices before creating an invitation",
                ));
            }
            let origin =
                origin.unwrap_or_else(|| session.clients.get(client).unwrap().origin.clone());
            if !origin.split_once("://").is_some_and(|(_, host)| {
                app.config
                    .expected_origin(host, app.remote.origin().as_deref())
                    .as_deref()
                    == Some(origin.as_str())
            }) {
                return Err(Error::new(
                    "origin",
                    "Pairing must target an active editor origin",
                ));
            }
            let code = format!("{:06}", rand::random_range(0..1_000_000u32));
            let invite = secret();
            let now = Instant::now();
            let issuer_token = session.clients.get(client).unwrap().auth_token.clone();
            let issuer = session.tokens.get(&issuer_token).unwrap();
            let credential_created = (!issuer.is_host).then_some(issuer.created);
            let lifetime = Duration::from_secs(120).min(
                credential_created
                    .map(|created| {
                        (created + auth::ABSOLUTE_TIMEOUT).saturating_duration_since(now)
                    })
                    .unwrap_or(Duration::from_secs(120)),
            );
            let expires_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
                + lifetime.as_millis() as u64;
            app.broadcast(json!({"type":"pairing_cancelled"}));
            session.pairing = Some(Pairing {
                code: code.clone(),
                invite: invite.clone(),
                origin: origin.clone(),
                issuer_token,
                credential_created,
                expires: now + lifetime,
                attempts: 0,
            });
            json!({"type":"pairing","code":code,"invite":invite,"origin":origin,"expiresAt":expires_at})
        }
        Command::RevokeDevice {
            target_client_id, ..
        } => {
            let token = session
                .clients
                .get(&target_client_id)
                .ok_or_else(|| Error::new("device", "The target device session was not found"))?
                .auth_token
                .clone();
            if auth::lookup(&session.tokens, &token).is_some_and(|(_, record)| record.is_host) {
                return Err(Error::new(
                    "host_session",
                    "The host session cannot be revoked",
                ));
            }
            session.tokens.remove(&token);
            session.remove_unpaired_clients();
            session.pairing = None;
            app.notify_auth();
            app.broadcast(json!({"type":"pairing_cancelled"}));
            app.broadcast(session.control());
            json!({"type":"ack","operation":"revoke_device"})
        }
        Command::RevokeAllDevices { .. } => {
            session.tokens.retain(|_, record| record.is_host);
            session.remove_unpaired_clients();
            session.pairing = None;
            app.notify_auth();
            app.broadcast(json!({"type":"pairing_cancelled"}));
            app.broadcast(session.control());
            json!({"type":"ack","operation":"revoke_all_devices"})
        }
        Command::TerminalStart { .. } => {
            let running = usize::from(app.terminal.snapshot().running)
                + session
                    .projects
                    .values()
                    .filter(|project| {
                        project
                            .terminal
                            .as_ref()
                            .is_some_and(|terminal| terminal.snapshot().running)
                    })
                    .count();
            if running >= 8 && !app.terminal_snapshot(&session, &project_id).running {
                return Err(Error::new(
                    "limit",
                    "Stop another project terminal before starting more than eight shells",
                ));
            }
            let terminal = app.ensure_project_terminal(&mut session, &project_id)?;
            if session.controller_for(&project_id).is_none() {
                session.claim(client, connection)?;
                app.broadcast(session.control());
            }
            terminal
                .ensure_started(session.root_for(&project_id)?)
                .map_err(|message| Error::new("terminal", message))?;
            json!({"type":"terminal_state","terminal":terminal.snapshot()})
        }
        Command::TerminalInput { data, .. } => {
            if data.len() > 16 * 1024 {
                return Err(Error::new(
                    "limit",
                    "Terminal input is limited to 16 KiB per command",
                ));
            }
            app.terminal_for(&session, &project_id)
                .ok_or_else(|| Error::new("terminal", "Start this project's terminal first"))?
                .input(data.as_bytes())
                .map_err(|message| Error::new("terminal", message))?;
            if session.controller_for(&project_id) != Some(client) {
                session.claim(client, connection)?;
                app.broadcast(session.control());
            }
            json!({"type":"ack","operation":"terminal_input"})
        }
        Command::TerminalResize { cols, rows, .. } => {
            if session.controller_for(&project_id) != Some(client) {
                return Ok(json!({"type":"ack","operation":"terminal_resize","ignored":true}));
            }
            app.terminal_for(&session, &project_id)
                .ok_or_else(|| Error::new("terminal", "Start this project's terminal first"))?
                .resize(cols, rows)
                .map_err(|message| Error::new("terminal", message))?;
            json!({"type":"terminal_state","terminal":app.terminal_snapshot(&session, &project_id)})
        }
        Command::TerminalStop { .. } => {
            if let Some(terminal) = app.terminal_for(&session, &project_id) {
                terminal.stop();
            }
            json!({"type":"terminal_state","terminal":app.terminal_snapshot(&session, &project_id)})
        }
        Command::TerminalHistory { limit } => {
            json!({"type":"terminal_history","lines":app.terminal_for(&session, &project_id).map(|terminal| terminal.history(limit.min(500))).unwrap_or_default()})
        }
        Command::AiOpenFile { target } => resolve_ai_file_link(&session, &project_id, &target)?,
        Command::AiStatus => {
            json!({"type":"ai_state","ai":app.ai_snapshot(&session, &project_id),"aiContext":session.context_for(&project_id),"providers":app.ai.providers()})
        }
        Command::AiSettingsGet => {
            json!({"type":"ai_settings","settings":app.ai.settings(),"settingsError":app.ai.settings_error(),"providers":app.ai.providers()})
        }
        Command::AiSettingsSet { settings, .. } => {
            if session
                .projects
                .values()
                .any(|project| project.ai.as_ref().is_some_and(ai::AiManager::is_busy))
            {
                return Err(Error::new(
                    "busy_ai",
                    "Wait for all active AI jobs before changing shared settings",
                ));
            }
            let settings = app
                .ai
                .configure(settings)
                .map_err(|message| Error::new("ai_settings", message))?;
            for project in session.projects.values() {
                if let Some(ai) = &project.ai {
                    ai.apply_shared_settings(&settings);
                }
            }
            let event = json!({"type":"ai_settings","settings":settings,"settingsError":app.ai.settings_error(),"providers":app.ai.providers()});
            app.broadcast(event.clone());
            event
        }
        Command::AiAuthRefresh { .. } => {
            let handle = tokio::runtime::Handle::try_current().map_err(|_| {
                Error::new(
                    "ai_auth",
                    "Authentication refresh requires the running host",
                )
            })?;
            let ai = app.ai.clone();
            let events = app.events.clone();
            handle.spawn(async move {
                if let Err(message) = ai.refresh_auth_checked().await {
                    let _ = events.send(Arc::new(
                        json!({"type":"error","code":"ai_auth","message":message}),
                    ));
                }
            });
            json!({"type":"ack","operation":"ai_auth_refresh"})
        }
        Command::AiStart {
            provider,
            prompt,
            path,
            ..
        } => {
            if prompt.len() > 32 * 1024 {
                return Err(Error::new("limit", "AI prompts are limited to 32 KiB"));
            }
            if session.workspace_for_mut(&project_id)?.has_unsaved() {
                return Err(Error::new(
                    "unsaved",
                    "Save or discard unsaved files before starting an AI job that can change the workspace",
                ));
            }
            let context = match path {
                Some(path) => {
                    let document = session.workspace_for_mut(&project_id)?.open(&path)?;
                    let context = AiContext {
                        path: document.path,
                        revision: document.revision,
                    };
                    // AI keeps only this path/revision, never a background editor
                    // buffer. Release even if starting the provider later fails.
                    session
                        .workspace_for_mut(&project_id)?
                        .release_saved_inactive()?;
                    Some(context)
                }
                None => None,
            };
            let busy = usize::from(app.ai.is_busy())
                + session
                    .projects
                    .values()
                    .filter(|project| project.ai.as_ref().is_some_and(ai::AiManager::is_busy))
                    .count();
            if busy >= 4
                && !app
                    .ai_for(&session, &project_id)
                    .is_some_and(|ai| ai.is_busy())
            {
                return Err(Error::new(
                    "limit",
                    "Finish or cancel another AI job before running more than four",
                ));
            }
            let manager = app.ensure_project_ai(&mut session, &project_id)?;
            manager.inherit_host_configuration(&app.ai);
            let snapshot = manager
                .start(
                    &provider,
                    &prompt,
                    context.as_ref().map(|context| context.path.as_str()),
                )
                .map_err(|message| Error::new("ai", message))?;
            session.set_context(&project_id, context);
            json!({"type":"ai_state","ai":snapshot,"aiContext":session.context_for(&project_id),"providers":app.ai.providers()})
        }
        Command::AiApprove { id, choice, .. } => {
            if ai::approval_grants_permission(&choice)
                && session.workspace_for_mut(&project_id)?.has_unsaved()
            {
                return Err(Error::new(
                    "unsaved",
                    "Save unsaved files before allowing an AI tool operation",
                ));
            }
            let manager = app
                .ai_for(&session, &project_id)
                .ok_or_else(|| Error::new("ai", "There is no AI job in this project"))?;
            let snapshot = manager
                .approve(&id, &choice)
                .map_err(|message| Error::new("ai", message))?;
            json!({"type":"ai_state","ai":snapshot,"aiContext":session.context_for(&project_id)})
        }
        Command::AiCancel { .. } => {
            json!({"type":"ai_state","ai":app.ai_for(&session, &project_id).ok_or_else(|| Error::new("ai", "There is no AI job in this project"))?.cancel().map_err(|message| Error::new("ai", message))?,"aiContext":session.context_for(&project_id)})
        }
        Command::Ping => json!({"type":"pong"}),
    };
    let mut response = response;
    if matches!(
        response["type"].as_str(),
        Some("file_state" | "file_patch" | "active_file" | "file_closed" | "ai_state")
    ) {
        let workspace = session.workspace_for_mut(&project_id)?;
        // A successfully acknowledged edit remains acknowledged if the optional
        // buffer-release checkpoint fails. The release itself restores all data.
        if let Err(error) = workspace.release_saved_inactive() {
            app.scoped_broadcast(
                &project_id,
                json!({"type":"error","code":error.code,"message":error.message}),
            );
        }
        let loaded = workspace.loaded_paths();
        let recent = workspace.recent_files();
        if let Some((before_loaded, before_recent)) = before_files {
            for path in before_loaded.iter().filter(|path| !loaded.contains(path)) {
                if response["type"] != "file_closed" || response["path"] != *path {
                    app.scoped_broadcast(&project_id, json!({"type":"file_unloaded","path":path}));
                }
            }
            if before_loaded != loaded || before_recent != recent {
                app.scoped_broadcast(
                    &project_id,
                    json!({"type":"file_shortcuts","paths":recent,"loadedPaths":loaded}),
                );
            }
        }
        if selects_file {
            app.scoped_broadcast(
                &project_id,
                json!({"type":"active_file","path":workspace.active_path}),
            );
        }
    }
    if matches!(
        response["type"].as_str(),
        Some(
            "files"
                | "file_state"
                | "file_patch"
                | "active_file"
                | "file_closed"
                | "terminal_state"
                | "terminal_history"
                | "ai_state"
        )
    ) {
        response["projectId"] = json!(project_id);
    }
    Ok(response)
}

// Resolve a transcript reference without reading its contents, opening a
// document, or changing another device's selected project. The ordinary
// project/file commands perform those operations after the user's click.
fn resolve_ai_file_link(
    session: &Session,
    selected_project: &str,
    target: &str,
) -> protocol::Result<Value> {
    let (path, line) = parse_ai_file_reference(target)?;
    let path = Path::new(path);
    let (root, relative) = if path.is_absolute() {
        let (root, relative) = session
            .roots()
            .into_iter()
            .filter_map(|root| {
                #[cfg(windows)]
                let comparable_root = Path::new(
                    root.to_str()?
                        .strip_prefix(r"\\?\")
                        .unwrap_or(root.to_str()?),
                );
                #[cfg(windows)]
                let comparable_path = Path::new(
                    path.to_str()?
                        .strip_prefix(r"\\?\")
                        .unwrap_or(path.to_str()?),
                );
                #[cfg(not(windows))]
                let (comparable_root, comparable_path) = (root.as_path(), path);
                comparable_path
                    .strip_prefix(comparable_root)
                    .ok()
                    .map(|relative| (root.clone(), relative.to_owned()))
            })
            .max_by_key(|(root, _)| root.components().count())
            .ok_or_else(|| Error::new("path", "This file is outside the attached projects"))?;
        (root, relative)
    } else {
        (
            session.root_for(selected_project)?.to_owned(),
            path.to_owned(),
        )
    };
    let relative = relative
        .to_str()
        .ok_or_else(|| Error::new("path", "The file reference is not a valid path"))?
        .replace(std::path::MAIN_SEPARATOR, "/");
    workspace::resolve_root(&root, &relative, false)?;
    Ok(
        json!({"type":"ai_file_link","projectId":workspace::recovery_id(&root),"path":relative,"line":line}),
    )
}

fn parse_ai_file_reference(target: &str) -> protocol::Result<(&str, usize)> {
    let invalid = || {
        Error::new(
            "path",
            "Use an attached project file with an optional line number",
        )
    };
    if target.is_empty() || target.len() > 4096 || target.chars().any(char::is_control) {
        return Err(invalid());
    }
    let number = |value: &str| -> protocol::Result<usize> {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        value
            .parse::<usize>()
            .ok()
            .filter(|line| (1..=1_000_000).contains(line))
            .ok_or_else(invalid)
    };
    let mut path = target;
    let mut line = 1;
    if let Some((file, anchor)) = target.rsplit_once('#') {
        let anchor = anchor.strip_prefix('L').ok_or_else(invalid)?;
        let (start, end) = anchor
            .split_once('-')
            .map_or((anchor, None), |(start, end)| (start, Some(end)));
        line = number(start)?;
        if let Some(end) = end {
            let end = number(end.strip_prefix('L').unwrap_or(end))?;
            if end < line {
                return Err(invalid());
            }
        }
        path = file;
    } else if let Some((file, suffix)) = target.rsplit_once(':').filter(|(_, suffix)| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        line = number(suffix)?;
        // Codex references can also contain a column after the line.
        if let Some((file_without_line, possible_line)) = file.rsplit_once(':') {
            if possible_line.bytes().all(|byte| byte.is_ascii_digit()) {
                line = number(possible_line)?;
                path = file_without_line;
            } else {
                path = file;
            }
        } else {
            path = file;
        }
    }
    if let Some(relative) = path.strip_prefix("./") {
        path = relative;
    }
    #[cfg(windows)]
    let native_absolute = Path::new(path).is_absolute()
        && matches!(
            Path::new(path).components().next(),
            Some(std::path::Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))
        );
    #[cfg(not(windows))]
    let native_absolute = false;
    let checked = if native_absolute {
        &path.strip_prefix(r"\\?\").unwrap_or(path)[2..]
    } else {
        path
    };
    if path.is_empty()
        || checked.contains([':', '?', '#'])
        || (!native_absolute && path.contains('\\'))
        || path.starts_with("//")
    {
        return Err(invalid());
    }
    Ok((path, line))
}

async fn index(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static_asset(
        &app,
        &headers,
        "text/html; charset=utf-8",
        "index.html",
        include_bytes!("../web/index.html"),
    )
    .await
}
async fn javascript(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static_asset(
        &app,
        &headers,
        "text/javascript; charset=utf-8",
        "app.js",
        include_bytes!("../web/app.js"),
    )
    .await
}
async fn editor_javascript(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static_asset(
        &app,
        &headers,
        "text/javascript; charset=utf-8",
        "editor.js",
        include_bytes!("../web/editor.js"),
    )
    .await
}
async fn stylesheet(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static_asset(
        &app,
        &headers,
        "text/css; charset=utf-8",
        "style.css",
        include_bytes!("../web/style.css"),
    )
    .await
}
async fn brand_image(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let (name, bytes): (&str, &[u8]) = match uri.path() {
        "/favicon.png" => ("favicon.png", include_bytes!("../web/favicon.png")),
        "/apple-touch-icon.png" => (
            "apple-touch-icon.png",
            include_bytes!("../web/apple-touch-icon.png"),
        ),
        "/logo.png" => ("logo.png", include_bytes!("../web/logo.png")),
        _ => return error_response(StatusCode::NOT_FOUND, "asset", "Unknown brand asset"),
    };
    static_asset(&app, &headers, "image/png", name, bytes).await
}
async fn static_asset(
    app: &App,
    headers: &HeaderMap,
    content_type: &'static str,
    name: &'static str,
    bytes: &'static [u8],
) -> Response {
    if !app.accepts_headers(headers, false) {
        return error_response(StatusCode::FORBIDDEN, "host", "Host is not allowed");
    }
    let body = if let Some(directory) = app.config.dev_assets.clone() {
        match tokio::task::spawn_blocking(move || dev::read_asset(&directory, name)).await {
            Ok(Ok(bytes)) => Body::from(bytes),
            _ => {
                return error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "dev_asset",
                    "Development asset is missing or invalid; fix the file and reload",
                );
            }
        }
    } else {
        Body::from(bytes)
    };
    protect(
        Response::builder()
            .header(header::CONTENT_TYPE, content_type)
            .body(body)
            .unwrap(),
    )
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Nimlo: {error}");
        std::process::exit(1);
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        if let (Ok(mut terminate), Ok(mut hangup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
        ) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => {}
                _ = hangup.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn run() -> std::result::Result<(), String> {
    let mut config = Config::parse()?;
    let root = std::fs::canonicalize(&config.workspace).map_err(|error| error.to_string())?;
    config.prepare_state(&root)?;
    let workspace = workspace::Workspace::new(&root, config.project_state(&root))
        .map_err(|error| error.message)?;
    if let (Some(directory), Some(owner)) = (&config.state_dir, &config.state_owner) {
        let marker = directory.join("project-root.json");
        if !marker.exists() {
            write_project_preference(&marker, owner)
                .map_err(|error| format!("Cannot preserve project recovery ownership: {error}"))?;
        }
    }
    config.workspace = workspace.root.clone();
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|e| e.to_string())?;
    config.listen = listener.local_addr().map_err(|e| e.to_string())?;
    if !config.listen.ip().is_loopback() {
        for interface in if_addrs::get_if_addrs().map_err(|error| error.to_string())? {
            let ip = interface.ip();
            let private = match ip {
                IpAddr::V4(ip) => {
                    ip.is_private()
                        || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
                }
                IpAddr::V6(ip) => ip.is_unique_local(),
            };
            if private
                && (config.listen.ip().is_unspecified() || config.listen.ip() == ip)
                && config.listen.is_ipv4() == ip.is_ipv4()
            {
                config.connect_urls.push(format!(
                    "http://{}",
                    SocketAddr::new(ip, config.listen.port())
                ));
            }
        }
        config.connect_urls.sort();
        config.connect_urls.dedup();
    }
    let token = secret();
    let (events, _) = broadcast::channel(16);
    let (ai_changed, _) = watch::channel(0u64);
    let notify_sender = ai_changed.clone();
    let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        notify_sender.send_modify(|version| *version = version.wrapping_add(1));
    });
    let ai = match config.state_dir.as_ref() {
        Some(directory) => ai::AiManager::new_with_settings_path(
            workspace.root.clone(),
            notify,
            directory.join("ai-settings.json"),
        ),
        None => ai::AiManager::new(workspace.root.clone(), notify),
    };
    let app = Arc::new(App {
        config: config.clone(),
        remote: remote::RemoteManager::new(config.listen),
        session: Mutex::new(Session {
            access: AccessPolicy::load(config.access_settings_path().as_deref()),
            projects: BTreeMap::new(),
            views: BTreeMap::new(),
            primary_attached: true,
            workspace,
            session_id: secret(),
            controller_id: None,
            generation: 1,
            clients: BTreeMap::new(),
            pairing: None,
            tokens: BTreeMap::from([(token.clone(), auth::TokenRecord::host(Instant::now()))]),
            ai_context: None,
        }),
        events,
        terminal: terminal::Terminal::new(),
        ai,
        ai_changed,
        auth_changed: watch::channel(0).0,
        connections: Arc::new(Semaphore::new(MAX_CLIENTS * 2)),
        shutdown: watch::channel(false).0,
        folder_picker: Mutex::new(false),
        pc_recovery: browser::Recovery::default(),
    });
    app.restore_projects()
        .map_err(|error| format!("Cannot restore attached projects: {}", error.message))?;
    // Native folder selection starts a fresh host with --workspace, rather than
    // sending a later project-open command that would normally save this choice.
    let _ = app.remember_desktop_startup_project();
    let auth_probe = app.clone();
    tokio::spawn(async move {
        auth_probe.ai.refresh_auth().await;
    });
    let expiration_monitor = app.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        let mut shutdown = expiration_monitor.shutdown.subscribe();
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = ticker.tick() => {
                    let mut session = expiration_monitor.session.lock().unwrap();
                    if session.prune_expired(Instant::now()) {
                        expiration_monitor.notify_auth();
                        expiration_monitor.broadcast(session.control());
                    }
                }
            }
        }
    });
    let monitor = app.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        loop {
            ticker.tick().await;
            let app = monitor.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let mut session = app.session.lock().unwrap();
                let primary_id = session.primary_id();
                let mut changes = Vec::new();
                let refresh = |workspace: &mut workspace::Workspace| {
                    let before = workspace.loaded_paths();
                    workspace.refresh().map(|documents| {
                        let release_error = workspace.release_saved_inactive().err();
                        (documents, before, workspace.loaded_paths(), workspace.recent_files().to_vec(), release_error)
                    })
                };
                changes.push((primary_id, refresh(&mut session.workspace)));
                for (id, project) in &mut session.projects {
                    if let Some(workspace) = &mut project.workspace {
                        changes.push((id.clone(), refresh(workspace)));
                    }
                }
                for (project_id, result) in changes {
                    match result {
                        Ok((documents, before, loaded, recent, release_error)) => {
                            for document in documents {
                                app.scoped_broadcast(
                                    &project_id,
                                    json!({"type":"file_state","file":document}),
                                );
                            }
                            if let Some(error) = release_error {
                                app.scoped_broadcast(&project_id, json!({"type":"error","code":error.code,"message":error.message}));
                            }
                            if before != loaded {
                                for path in before.iter().filter(|path| !loaded.contains(path)) {
                                    app.scoped_broadcast(&project_id, json!({"type":"file_unloaded","path":path}));
                                }
                                app.scoped_broadcast(&project_id, json!({"type":"file_shortcuts","paths":recent,"loadedPaths":loaded}));
                            }
                        }
                        Err(error) => app.scoped_broadcast(
                            &project_id,
                            json!({"type":"error","code":error.code,"message":error.message}),
                        ),
                    }
                }
            })
            .await;
        }
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/app.js", get(javascript))
        .route("/editor.js", get(editor_javascript))
        .route("/style.css", get(stylesheet))
        .route("/favicon.png", get(brand_image))
        .route("/apple-touch-icon.png", get(brand_image))
        .route("/logo.png", get(brand_image))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/pair", post(pair))
        .route("/api/pc/open", post(pc_open))
        .route("/ws", get(websocket))
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn_with_state(
            app.clone(),
            response_security,
        ))
        .with_state(app.clone());
    let origin = config.pc_origin();
    let launch_link = format!("{origin}/#token={token}");
    if config.desktop {
        use std::io::Write;
        println!("{}", json!({"type":"ready","url":launch_link}));
        std::io::stdout()
            .flush()
            .map_err(|error| error.to_string())?;
    } else {
        println!("Nimlo workspace: {}", config.workspace.display());
        println!("Open this private launch link on your PC:\n{launch_link}");
    }
    if config.open_browser {
        let opening_app = app.clone();
        tokio::spawn(async move {
            if let Err(error) = opening_app
                .open_pc_browser(
                    &opening_app.config.pc_origin(),
                    browser::open_private_browser,
                )
                .await
            {
                eprintln!("{}", error.message());
            }
        });
    }
    if !config.desktop {
        println!(
            "The host keeps unsaved buffers and processes when a browser disconnects. Ctrl+C stops the host."
        );
    }
    for url in &config.connect_urls {
        println!("Device pairing page: {url}");
    }
    if let Some(origin) = &config.origin {
        println!("Configured device pairing page: {origin}");
    }
    if !config.listen.ip().is_loopback() && config.origin.is_none() {
        println!(
            "LAN access enabled explicitly. Pair devices from the workspace menu; use only a trusted network. Choose Internet in Pair a device for an encrypted link."
        );
    }
    let shutdown_app = app.clone();
    // A closed parent pipe also ends an owned desktop host after a shell crash.
    let (parent_closed, parent_exit) = tokio::sync::oneshot::channel();
    if config.desktop {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut byte = [0u8; 64];
            let mut stdin = std::io::stdin().lock();
            while matches!(stdin.read(&mut byte), Ok(n) if n > 0) {}
            let _ = parent_closed.send(());
        });
    }
    let result = transport::serve(listener, router, async move {
        if config.desktop {
            tokio::select! { _ = shutdown_signal() => {}, _ = parent_exit => {} }
        } else {
            shutdown_signal().await;
        }
        shutdown_app.shutdown.send_replace(true);
        shutdown_app.remote.shutdown().await;
    })
    .await;
    app.shutdown.send_replace(true);
    app.remote.shutdown().await;
    app.terminal.stop();
    let _ = app.ai.cancel();
    for project in app.session.lock().unwrap().projects.values() {
        if let Some(terminal) = &project.terminal {
            terminal.stop();
        }
        if let Some(ai) = &project.ai {
            let _ = ai.cancel();
        }
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            workspace: PathBuf::new(),
            state_dir: None,
            listen: "127.0.0.1:7410".parse().unwrap(),
            origin: None,
            connect_urls: Vec::new(),
            project_preference: None,
            state_owner: None,
            open_browser: false,
            desktop: false,
            dev_assets: None,
        }
    }
    fn test_app() -> (tempfile::TempDir, tempfile::TempDir, Arc<App>, String) {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("test.txt"), "original").unwrap();
        let workspace = workspace::Workspace::new(root.path(), Some(state.path().into())).unwrap();
        let token = secret();
        let (events, _) = broadcast::channel(16);
        let (ai_changed, _) = watch::channel(0);
        let app = Arc::new(App {
            config: Config {
                workspace: workspace.root.clone(),
                state_owner: Some(workspace.root.clone()),
                state_dir: Some(state.path().into()),
                ..config()
            },
            remote: remote::RemoteManager::new(config().listen),
            session: Mutex::new(Session {
                access: AccessPolicy::default(),
                projects: BTreeMap::new(),
                views: BTreeMap::new(),
                primary_attached: true,
                workspace,
                session_id: secret(),
                controller_id: None,
                generation: 1,
                clients: BTreeMap::new(),
                pairing: None,
                tokens: BTreeMap::from([(token.clone(), auth::TokenRecord::host(Instant::now()))]),
                ai_context: None,
            }),
            events,
            terminal: terminal::Terminal::new(),
            ai: ai::AiManager::new_with_settings_path(
                root.path().into(),
                Arc::new(|| {}),
                state.path().join("ai-settings.json"),
            ),
            ai_changed,
            auth_changed: watch::channel(0).0,
            connections: Arc::new(Semaphore::new(16)),
            shutdown: watch::channel(false).0,
            folder_picker: Mutex::new(false),
            pc_recovery: browser::Recovery::default(),
        });
        (root, state, app, token)
    }
    fn own_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:7410"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:7410"),
        );
        headers
    }
    #[test]
    fn ai_file_references_parse_supported_lines_and_reject_unsafe_targets() {
        for (target, expected) in [
            ("README.md", ("README.md", 1)),
            ("./src/main.rs:155", ("src/main.rs", 155)),
            ("src/main.rs:155:9", ("src/main.rs", 155)),
            ("src/main.rs#L12-L19", ("src/main.rs", 12)),
            (
                "/project/file with spaces.md:3",
                ("/project/file with spaces.md", 3),
            ),
        ] {
            assert_eq!(parse_ai_file_reference(target).unwrap(), expected);
        }
        for target in [
            "",
            "javascript:alert(1)",
            "https://example.test/file",
            "file:///tmp/a",
            "data:text/html,x",
            "//remote/file",
            "file.md:0",
            "file.md:1000001",
            "file.md#L8-L2",
            "file.md?query",
            "file.md\n",
            "src\\file.rs",
        ] {
            assert!(parse_ai_file_reference(target).is_err(), "{target:?}");
        }
        assert!(parse_ai_file_reference(&"x".repeat(4097)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_references_accept_drives_but_reject_streams_and_network_paths() {
        for (target, expected) in [
            (r"C:\project\file.rs", (r"C:\project\file.rs", 1)),
            ("C:/project/file.rs:12:3", ("C:/project/file.rs", 12)),
            (r"\\?\C:\project\file.rs#L4", (r"\\?\C:\project\file.rs", 4)),
        ] {
            assert_eq!(parse_ai_file_reference(target).unwrap(), expected);
        }
        for target in [
            r"C:relative.rs",
            r"C:\project\file.rs:stream",
            r"C:\project\file.rs:stream:4",
            r"\\server\share\file.rs",
            r"\\?\UNC\server\share\file.rs",
            r"\\.\C:\project\file.rs",
        ] {
            assert!(parse_ai_file_reference(target).is_err(), "{target:?}");
        }
    }

    #[test]
    fn ai_file_links_resolve_only_attached_roots_without_changing_session() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("other.md"), "linked file").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        let attached = execute(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: other.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let before = app.bootstrap(Some("desktop")).unwrap();
        let other_root = std::fs::canonicalize(other.path()).unwrap();
        let reply = execute_scoped(
            &app,
            "desktop",
            1,
            Command::AiOpenFile {
                target: format!("{}/other.md:7", other_root.display()),
            },
            Some(before["projectId"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(reply["projectId"], attached["projectId"]);
        assert_eq!(reply["path"], "other.md");
        assert_eq!(reply["line"], 7);
        #[cfg(windows)]
        {
            let native = other_root.to_str().unwrap();
            let ordinary = native.strip_prefix(r"\\?\").unwrap_or(native);
            for root in [ordinary.to_owned(), ordinary.replace('\\', "/")] {
                let reply = resolve_ai_file_link(
                    &app.session.lock().unwrap(),
                    before["projectId"].as_str().unwrap(),
                    &format!("{root}/other.md:7"),
                )
                .unwrap();
                assert_eq!(reply["projectId"], attached["projectId"]);
                assert_eq!(reply["path"], "other.md");
            }
        }
        let relative = execute(
            &app,
            "desktop",
            1,
            Command::AiOpenFile {
                target: "test.txt#L2".into(),
            },
        )
        .unwrap();
        assert_eq!(relative["projectId"], before["projectId"]);
        let after = app.bootstrap(Some("desktop")).unwrap();
        assert_eq!(after["projectId"], before["projectId"]);
        assert_eq!(after["openFiles"], before["openFiles"]);
        assert_eq!(after["generation"], before["generation"]);
        assert_eq!(after["aiContext"], before["aiContext"]);
        for target in [
            "../secret.txt".to_owned(),
            "nested/../test.txt".to_owned(),
            "missing.txt".to_owned(),
            format!("{}/secret.txt", outside.path().display()),
        ] {
            assert!(execute(&app, "desktop", 1, Command::AiOpenFile { target }).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                outside.path().join("secret.txt"),
                root.path().join("escape.txt"),
            )
            .unwrap();
            assert!(
                execute(
                    &app,
                    "desktop",
                    1,
                    Command::AiOpenFile {
                        target: "escape.txt".into()
                    }
                )
                .is_err()
            );
        }
        assert!(
            execute(
                &app,
                "unknown",
                3,
                Command::AiOpenFile {
                    target: "test.txt".into()
                }
            )
            .is_err()
        );
        assert!(
            execute_scoped(
                &app,
                "desktop",
                1,
                Command::AiOpenFile {
                    target: "test.txt".into()
                },
                Some("stale-project")
            )
            .is_err()
        );
    }
    #[test]
    fn every_affirmative_ai_decision_preserves_unsaved_work() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let opened = execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: opened["file"]["revision"].as_u64().unwrap(),
                content: "unsaved review".into(),
                generation: 1,
            },
        )
        .unwrap();
        for choice in [
            "accept",
            "accept_for_session",
            "accept_with_execpolicy_amendment",
            "allow_network_0",
        ] {
            let error = execute(
                &app,
                "desktop",
                1,
                Command::AiApprove {
                    id: "pending-fixture".into(),
                    choice: choice.into(),
                    generation: 1,
                },
            )
            .unwrap_err();
            assert_eq!(error.code, "unsaved", "{choice}");
        }
        let error = execute(
            &app,
            "desktop",
            1,
            Command::AiApprove {
                id: "pending-fixture".into(),
                choice: "decline".into(),
                generation: 1,
            },
        )
        .unwrap_err();
        assert_ne!(error.code, "unsaved");
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .workspace
                .document("test.txt")
                .unwrap()
                .content,
            "unsaved review"
        );
    }
    fn pc_open_headers() -> HeaderMap {
        let mut headers = own_headers();
        headers.insert("x-nimlo-launch", HeaderValue::from_static("1"));
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        headers.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        headers.insert("sec-fetch-dest", HeaderValue::from_static("empty"));
        headers
    }
    async fn response_json(response: Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn canonical_pc_origin_keeps_the_actual_listener_port_and_address_family() {
        for (listen, expected) in [
            ("127.0.0.1:8767", "http://127.0.0.1:8767"),
            ("127.0.0.2:7410", "http://127.0.0.2:7410"),
            ("0.0.0.0:8767", "http://127.0.0.1:8767"),
            ("[::1]:8767", "http://[::1]:8767"),
            ("[::]:8767", "http://[::1]:8767"),
        ] {
            let mut config = config();
            config.listen = listen.parse().unwrap();
            assert_eq!(config.pc_origin(), expected);
        }
    }
    #[tokio::test]
    async fn signed_out_bootstrap_exposes_only_nonsecret_local_recovery_metadata() {
        let (_root, _state, mut app, token) = test_app();
        {
            let config = &mut Arc::get_mut(&mut app).unwrap().config;
            config.listen = "0.0.0.0:7410".parse().unwrap();
            config.origin = Some("https://nimlo.example".into());
            config.connect_urls = vec!["http://192.168.1.5:7410".into()];
        }
        let loopback = "127.0.0.1:12345".parse().unwrap();
        let response = bootstrap(
            State(app.clone()),
            ConnectInfo(loopback),
            own_headers(),
            Query(ConnectionQuery::default()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = response_json(response).await;
        assert_eq!(body["pcOrigin"], "http://127.0.0.1:7410");
        assert!(!body.to_string().contains(&token));
        assert!(body.get("workspace").is_none());
        assert!(body.get("clients").is_none());
        assert!(!body["pcOrigin"].as_str().unwrap().contains('#'));

        let mut requests = Vec::new();
        requests.push(("192.168.1.9:12345".parse().unwrap(), own_headers()));
        for proxy in [
            "forwarded",
            "x-real-ip",
            "x-forwarded-for",
            "cf-connecting-ip",
        ] {
            let mut headers = own_headers();
            headers.insert(proxy, HeaderValue::from_static("127.0.0.1"));
            requests.push((loopback, headers));
        }
        for (host, origin) in [
            ("192.168.1.5:7410", "http://192.168.1.5:7410"),
            ("nimlo.example", "https://nimlo.example"),
            ("127.0.0.1:9999", "http://127.0.0.1:9999"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            requests.push((loopback, headers));
        }
        for (remote, headers) in requests {
            let response = bootstrap(
                State(app.clone()),
                ConnectInfo(remote),
                headers,
                Query(ConnectionQuery::default()),
            )
            .await;
            assert_ne!(response.status(), StatusCode::OK);
            assert!(response_json(response).await.get("pcOrigin").is_none());
        }
    }
    #[tokio::test]
    async fn pc_recovery_requires_local_peer_authority_origin_intent_and_fetch_metadata() {
        let (_root, _state, app, _token) = test_app();
        let loopback = "127.0.0.1:12345".parse().unwrap();
        let mut requests = vec![("192.168.1.9:12345".parse().unwrap(), pc_open_headers())];
        for name in ["host", "origin", "x-nimlo-launch"] {
            let mut missing = pc_open_headers();
            missing.remove(name);
            requests.push((loopback, missing));
            let mut duplicate = pc_open_headers();
            duplicate.append(name, duplicate.get(name).unwrap().clone());
            requests.push((loopback, duplicate));
        }
        for (name, value) in [
            ("host", "127.0.0.1:9999"),
            ("host", "attacker.example:7410"),
            ("origin", "http://attacker.example"),
            ("origin", "null"),
            ("x-nimlo-launch", "true"),
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-site", "same-site"),
            ("sec-fetch-site", "none"),
            ("sec-fetch-mode", "navigate"),
            ("sec-fetch-mode", "no-cors"),
            ("sec-fetch-dest", "document"),
            ("sec-fetch-user", "?1"),
            ("forwarded", "for=127.0.0.1"),
            ("x-real-ip", "127.0.0.1"),
            ("x-forwarded-for", "127.0.0.1"),
            ("cf-connecting-ip", "127.0.0.1"),
        ] {
            let mut headers = pc_open_headers();
            headers.insert(name, HeaderValue::from_str(value).unwrap());
            requests.push((loopback, headers));
        }
        for name in ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] {
            let mut duplicate = pc_open_headers();
            duplicate.append(name, duplicate.get(name).unwrap().clone());
            requests.push((loopback, duplicate));
        }
        for (remote, headers) in requests {
            let response = pc_open_using(&app, remote, &headers, |_, _| async {
                panic!("Denied request spawned a browser opener")
            })
            .await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(response.headers().get(header::SET_COOKIE).is_none());
        }
        assert!(app.pc_recovery.begin(Instant::now()).is_ok());
    }
    #[tokio::test]
    async fn pc_recovery_opens_only_the_verified_local_private_link_and_returns_no_credentials() {
        let (_root, _state, app, token) = test_app();
        let mut headers = pc_open_headers();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:7410"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:7410"),
        );
        let expected_link = format!("http://localhost:7410/#token={token}");
        let response = pc_open_using(
            &app,
            "127.0.0.1:12345".parse().unwrap(),
            &headers,
            |link, _| async move {
                assert_eq!(link, expected_link);
                Ok(())
            },
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let body = response_json(response).await;
        assert_eq!(body["opened"], true);
        assert_eq!(body.as_object().unwrap().len(), 2);
        assert!(!body.to_string().contains(&token));
        assert!(!body.to_string().contains("http:"));
        assert_eq!(app.session.lock().unwrap().tokens.len(), 1);
        let response = pc_open_using(
            &app,
            "127.0.0.1:12345".parse().unwrap(),
            &headers,
            |_, _| async { panic!("Rate limited request spawned an opener") },
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }
    #[tokio::test]
    async fn pc_recovery_allows_absent_fetch_metadata_and_rejects_concurrent_openers() {
        let (_root, _state, app, _token) = test_app();
        let mut headers = pc_open_headers();
        for name in ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] {
            headers.remove(name);
        }
        let remote = "127.0.0.1:12345".parse().unwrap();
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let opening = pc_open_using(&app, remote, &headers, |_, _| async {
            entered.send(()).unwrap();
            released.await.unwrap();
            Ok(())
        });
        let competing = async {
            entry.await.unwrap();
            let response = pc_open_using(&app, remote, &headers, |_, _| async {
                panic!("A concurrent request spawned an opener")
            })
            .await;
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(response_json(response).await["code"], "pc_open_busy");
            release.send(()).unwrap();
        };
        let (response, ()) = tokio::join!(opening, competing);
        assert_eq!(response.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn pc_recovery_reports_safe_opener_errors_and_preserves_static_invitation_entry() {
        for error in [
            browser::OpenError::Failed,
            browser::OpenError::TimedOut,
            browser::OpenError::ShuttingDown,
        ] {
            let (_root, _state, app, token) = test_app();
            let response = pc_open_using(
                &app,
                "127.0.0.1:12345".parse().unwrap(),
                &pc_open_headers(),
                |_, _| async { Err(error) },
            )
            .await;
            assert_eq!(
                response.status(),
                if error == browser::OpenError::TimedOut {
                    StatusCode::GATEWAY_TIMEOUT
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                }
            );
            assert!(!response_json(response).await.to_string().contains(&token));
        }
        let (_root, _state, app, _token) = test_app();
        app.shutdown.send_replace(true);
        let response = pc_open_using(
            &app,
            "127.0.0.1:12345".parse().unwrap(),
            &pc_open_headers(),
            |_, _| async { panic!("Shutdown request spawned an opener") },
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        let mut headers = own_headers();
        headers.insert(header::HOST, HeaderValue::from_static("localhost:7410"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:7410"),
        );
        let response = index(State(app), headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::LOCATION).is_none());
    }
    fn paired_test_client(app: &App, id: &str, connection: u64, origin: &str) -> String {
        let token = secret();
        let mut session = app.session.lock().unwrap();
        session.tokens.insert(
            token.clone(),
            auth::TokenRecord::paired(origin.into(), Instant::now()),
        );
        session.clients.insert(
            id.into(),
            Client {
                permissions: DevicePermissions::FULL,
                supports_patches: false,
                id: id.into(),
                name: id.into(),
                connected: true,
                is_controller: false,
                is_host: false,
                connection,
                auth_token: token.clone(),
                local: false,
                origin: origin.into(),
            },
        );
        token
    }
    fn connect_test_devices(app: &App, token: &str) {
        let mut session = app.session.lock().unwrap();
        for (id, connection, local) in [("desktop", 1, true), ("phone123", 2, false)] {
            session.clients.insert(
                id.into(),
                Client {
                    permissions: DevicePermissions::FULL,
                    supports_patches: false,
                    id: id.into(),
                    name: id.into(),
                    connected: true,
                    is_controller: false,
                    is_host: true,
                    origin: "http://127.0.0.1:7410".into(),
                    connection,
                    auth_token: token.into(),
                    local,
                },
            );
        }
        session.claim("desktop", 1).unwrap();
    }
    #[test]
    fn attached_projects_preserve_dirty_buffers_shells_and_independent_device_views() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let next = tempfile::tempdir().unwrap();
        std::fs::write(next.path().join("test.txt"), "second disk").unwrap();
        let primary = app.bootstrap(Some("desktop")).unwrap();
        let primary_id = primary["projectId"].as_str().unwrap();
        let document = execute_scoped(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
            Some(primary_id),
        )
        .unwrap();
        execute_scoped(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: document["file"]["revision"].as_u64().unwrap(),
                content: "first unsaved".into(),
                generation: 1,
            },
            Some(primary_id),
        )
        .unwrap();
        execute(&app, "desktop", 1, Command::TerminalStart { generation: 1 }).unwrap();
        app.session.lock().unwrap().ai_context = Some(AiContext {
            path: "test.txt".into(),
            revision: 2,
        });
        let attached = execute_scoped(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
            Some(primary_id),
        )
        .unwrap();
        let second_id = attached["projectId"].as_str().unwrap();
        assert_eq!(attached["generation"], 2);
        assert_eq!(attached["sessionId"], primary["sessionId"]);
        assert_eq!(attached["projects"].as_array().unwrap().len(), 2);
        assert_eq!(attached["terminal"]["running"], false);
        assert!(attached["aiContext"].is_null());
        assert!(app.terminal.snapshot().running);
        let desktop = app.bootstrap(Some("desktop")).unwrap();
        assert_eq!(desktop["projectId"], primary_id);
        assert_eq!(desktop["generation"], 1);
        assert_eq!(desktop["openFiles"][0]["content"], "first unsaved");
        assert_eq!(desktop["aiContext"]["path"], "test.txt");
        let mut events = app.events.subscribe();
        let second = execute_scoped(
            &app,
            "phone123",
            2,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(2),
            },
            Some(second_id),
        )
        .unwrap();
        assert_eq!(second["file"]["content"], "second disk");
        assert_eq!(events.try_recv().unwrap()["projectId"], second_id);
        execute_scoped(
            &app,
            "phone123",
            2,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: second["file"]["revision"].as_u64().unwrap(),
                content: "second unsaved".into(),
                generation: 2,
            },
            Some(second_id),
        )
        .unwrap();
        assert_eq!(
            app.bootstrap(Some("desktop")).unwrap()["openFiles"][0]["content"],
            "first unsaved"
        );
        assert_eq!(
            execute_scoped(
                &app,
                "phone123",
                2,
                Command::SaveFile {
                    path: "test.txt".into(),
                    revision: 2,
                    generation: 2
                },
                Some(primary_id)
            )
            .unwrap_err()
            .code,
            "stale_project"
        );
        assert_eq!(
            execute_scoped(
                &app,
                "phone123",
                2,
                Command::CreateFile {
                    path: "stale.txt".into(),
                    content: "bad".into(),
                    generation: 1
                },
                Some(second_id)
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert!(!next.path().join("stale.txt").exists());
        assert_eq!(
            execute_scoped(
                &app,
                "phone123",
                2,
                Command::RemoveProject {
                    target_project_id: primary_id.into(),
                    generation: 2
                },
                Some(second_id)
            )
            .unwrap_err()
            .code,
            "unsaved"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: next.path().to_string_lossy().into_owned(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "multi_project"
        );
        app.terminal.stop();
    }

    #[test]
    fn file_and_history_budgets_are_shared_across_project_workspaces() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        for index in 0..8 {
            std::fs::write(root.path().join(format!("{index}.txt")), "small").unwrap();
            let opened = execute(
                &app,
                "desktop",
                1,
                Command::OpenFile {
                    path: format!("{index}.txt"),
                    generation: Some(1),
                },
            )
            .unwrap();
            execute(
                &app,
                "desktop",
                1,
                Command::EditFile {
                    path: format!("{index}.txt"),
                    base_revision: opened["file"]["revision"].as_u64().unwrap(),
                    content: format!("unsaved {index}"),
                    generation: 1,
                },
            )
            .unwrap();
        }
        let next = tempfile::tempdir().unwrap();
        std::fs::write(next.path().join("test.txt"), "second").unwrap();
        let attached = execute(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let id = attached["projectId"].as_str().unwrap();
        assert_eq!(
            execute_scoped(
                &app,
                "phone123",
                2,
                Command::OpenFile {
                    path: "test.txt".into(),
                    generation: Some(2)
                },
                Some(id)
            )
            .unwrap_err()
            .code,
            "limit"
        );
        let closing_revision = app
            .session
            .lock()
            .unwrap()
            .workspace
            .document("7.txt")
            .unwrap()
            .revision;
        execute(
            &app,
            "desktop",
            1,
            Command::CloseFile {
                path: "7.txt".into(),
                discard: true,
                revision: Some(closing_revision),
                generation: 1,
            },
        )
        .unwrap();
        execute_scoped(
            &app,
            "phone123",
            2,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(2),
            },
            Some(id),
        )
        .unwrap();
        for (client, connection, path, generation) in
            [("desktop", 1, "0.txt", 1), ("phone123", 2, "test.txt", 2)]
        {
            for fill in ['a', 'b', 'c', 'd'] {
                let revision = app.bootstrap(Some(client)).unwrap()["openFiles"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|file| file["path"] == path)
                    .unwrap()["revision"]
                    .as_u64()
                    .unwrap();
                execute(
                    &app,
                    client,
                    connection,
                    Command::EditFile {
                        path: path.into(),
                        base_revision: revision,
                        content: fill.to_string().repeat(workspace::MAX_FILE),
                        generation,
                    },
                )
                .unwrap();
            }
        }
        let session = app.session.lock().unwrap();
        let totals = session.usage_except("no-project");
        assert_eq!(totals.0, workspace::MAX_OPEN);
        assert!(totals.1 <= workspace::MAX_BUFFERS);
        assert!(totals.2 <= workspace::MAX_HISTORY);
    }

    #[test]
    fn restored_projects_and_cross_project_folder_reads_remain_metadata_only() {
        let (_root, state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let next = tempfile::tempdir().unwrap();
        std::fs::create_dir(next.path().join("src")).unwrap();
        std::fs::write(next.path().join("src/file.txt"), "not loaded").unwrap();
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        projects::save(&state.path().join("projects.json"), vec![canonical.clone()]).unwrap();
        app.restore_projects().unwrap();
        let primary = app.bootstrap(Some("desktop")).unwrap();
        let id = workspace::recovery_id(&canonical);
        let entries = execute_scoped(
            &app,
            "phone123",
            2,
            Command::ListProjectFiles {
                target_project_id: id.clone(),
                directory: "src".into(),
                generation: 1,
            },
            primary["projectId"].as_str(),
        )
        .unwrap();
        assert_eq!(entries["files"][0]["path"], "src/file.txt");
        assert_eq!(entries["targetProjectId"], id);
        assert_eq!(
            app.bootstrap(Some("phone123")).unwrap()["projectId"],
            primary["projectId"]
        );
        assert_eq!(app.bootstrap(Some("phone123")).unwrap()["generation"], 1);
        let session = app.session.lock().unwrap();
        let project = &session.projects[&id];
        assert!(project.workspace.is_none());
        assert!(project.ai.is_none());
        assert!(project.terminal.is_none());
        drop(session);
        assert!(!app.config.project_state(&canonical).unwrap().exists());
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::ListProjectFiles {
                    target_project_id: id,
                    directory: "../outside".into(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "path"
        );
    }

    #[test]
    fn project_name_search_requires_live_scope_and_keeps_projects_metadata_only() {
        let (_root, state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let next = tempfile::tempdir().unwrap();
        std::fs::create_dir(next.path().join("src")).unwrap();
        std::fs::write(next.path().join("src/nested.txt"), "not loaded").unwrap();
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        projects::save(&state.path().join("projects.json"), vec![canonical.clone()]).unwrap();
        app.restore_projects().unwrap();
        let primary = app.bootstrap(Some("desktop")).unwrap();
        let primary_id = primary["projectId"].as_str().unwrap();
        let target_id = workspace::recovery_id(&canonical);
        let command = |generation| Command::SearchProjectFiles {
            target_project_id: target_id.clone(),
            query: "NESTED".into(),
            cursor: None,
            generation,
        };
        let result = execute_scoped(&app, "phone123", 2, command(1), Some(primary_id)).unwrap();
        assert_eq!(result["type"], "project_file_search");
        assert_eq!(result["files"][0]["path"], "src/nested.txt");
        assert_eq!(result["truncated"], false);
        assert_eq!(result["targetProjectId"], target_id);
        assert_eq!(
            execute_scoped(&app, "phone123", 2, command(0), Some(primary_id))
                .unwrap_err()
                .code,
            "stale_generation"
        );
        assert_eq!(
            execute_scoped(&app, "phone123", 2, command(1), Some("wrong-project"))
                .unwrap_err()
                .code,
            "stale_project"
        );
        assert!(execute_scoped(&app, "phone123", 99, command(1), Some(primary_id)).is_err());
        assert!(execute_scoped(&app, "unknown-device", 2, command(1), Some(primary_id)).is_err());
        assert!(
            execute_scoped(
                &app,
                "phone123",
                2,
                Command::SearchProjectFiles {
                    target_project_id: "not-attached".into(),
                    query: "nested".into(),
                    cursor: None,
                    generation: 1,
                },
                Some(primary_id)
            )
            .is_err()
        );
        let session = app.session.lock().unwrap();
        let project = &session.projects[&target_id];
        assert!(project.workspace.is_none());
        assert!(project.ai.is_none());
        assert!(project.terminal.is_none());
        assert_eq!(session.client_generation(Some("phone123")), 1);
        assert!(session.workspace.documents().is_empty());
        drop(session);
        assert!(!app.config.project_state(&canonical).unwrap().exists());
    }

    #[test]
    fn detaching_the_primary_releases_clean_buffers_and_keeps_all_files_on_disk() {
        let (root, state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let primary_id = app.session.lock().unwrap().primary_id();
        for index in 0..8 {
            std::fs::write(root.path().join(format!("{index}.txt")), "disk").unwrap();
            execute(
                &app,
                "desktop",
                1,
                Command::OpenFile {
                    path: format!("{index}.txt"),
                    generation: Some(1),
                },
            )
            .unwrap();
        }
        let next = tempfile::tempdir().unwrap();
        std::fs::write(next.path().join("test.txt"), "new disk").unwrap();
        let attached = execute(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let next_id = attached["projectId"].as_str().unwrap();
        execute_scoped(
            &app,
            "phone123",
            2,
            Command::RemoveProject {
                target_project_id: primary_id,
                generation: 2,
            },
            Some(next_id),
        )
        .unwrap();
        assert_eq!(app.session.lock().unwrap().workspace.usage(), (0, 0, 0));
        let reopened = workspace::Workspace::new(root.path(), Some(state.path().into())).unwrap();
        drop(reopened);
        assert_eq!(
            app.bootstrap(Some("desktop")).unwrap()["projectId"],
            next_id
        );
        assert_eq!(app.bootstrap(Some("desktop")).unwrap()["generation"], 2);
        execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(2),
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("0.txt")).unwrap(),
            "disk"
        );
        let roots = projects::load(&state.path().join("projects.json")).unwrap();
        assert_eq!(roots, vec![std::fs::canonicalize(next.path()).unwrap()]);
        assert_eq!(
            execute(
                &app,
                "phone123",
                2,
                Command::RemoveProject {
                    target_project_id: next_id.into(),
                    generation: 2
                }
            )
            .unwrap_err()
            .code,
            "last_project"
        );
    }

    #[test]
    fn project_terminals_keep_independent_viewport_owners() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let primary_id = app.session.lock().unwrap().primary_id();
        execute(&app, "desktop", 1, Command::TerminalStart { generation: 1 }).unwrap();
        let next = tempfile::tempdir().unwrap();
        let attached = execute(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let id = attached["projectId"].as_str().unwrap();
        execute(
            &app,
            "phone123",
            2,
            Command::TerminalStart { generation: 2 },
        )
        .unwrap();
        execute(
            &app,
            "phone123",
            2,
            Command::TerminalResize {
                cols: 42,
                rows: 15,
                generation: 2,
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::TerminalResize {
                cols: 90,
                rows: 25,
                generation: 1,
            },
        )
        .unwrap();
        let session = app.session.lock().unwrap();
        assert_eq!(session.controller_for(&primary_id), Some("desktop"));
        assert_eq!(session.controller_for(id), Some("phone123"));
        assert_eq!(app.terminal.snapshot().cols, 90);
        let terminal = app.terminal_for(&session, id).unwrap();
        assert_eq!(terminal.snapshot().cols, 42);
        drop(session);
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::RemoveProject {
                    target_project_id: id.into(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "busy_terminal"
        );
        terminal.stop();
        app.terminal.stop();
    }

    #[test]
    fn recovered_documents_are_fenced_before_any_over_budget_workspace_is_committed() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        let next = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        let mut recovery =
            workspace::Workspace::new(&canonical, app.config.project_state(&canonical)).unwrap();
        for index in 0..8 {
            std::fs::write(next.path().join(format!("{index}.txt")), "saved").unwrap();
            let path = format!("{index}.txt");
            let opened = recovery.open(&path).unwrap();
            recovery
                .edit(&path, opened.revision, format!("unsaved {index}"))
                .unwrap();
        }
        drop(recovery);
        let drafts = app
            .config
            .project_state(&canonical)
            .unwrap()
            .join("drafts.json");
        let before = std::fs::read(&drafts).unwrap();
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::AddProject {
                    path: canonical.to_string_lossy().into_owned(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "limit"
        );
        assert_eq!(std::fs::read(&drafts).unwrap(), before);
        assert!(app.session.lock().unwrap().projects.is_empty());
        assert_eq!(app.bootstrap(Some("desktop")).unwrap()["generation"], 1);
    }

    #[test]
    fn clean_recovery_migrates_to_one_active_buffer_with_recent_shortcuts() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        let next = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        let mut recovery =
            workspace::Workspace::new(&canonical, app.config.project_state(&canonical)).unwrap();
        // Reproduce an older checkpoint that retained eight saved buffers.
        for index in 0..workspace::MAX_OPEN {
            let path = format!("{index}.txt");
            std::fs::write(next.path().join(&path), "saved").unwrap();
            recovery.open(&path).unwrap();
        }
        assert_eq!(recovery.usage().0, workspace::MAX_OPEN);
        drop(recovery);
        execute(
            &app,
            "desktop",
            1,
            Command::AddProject {
                path: canonical.to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let bootstrap = app.bootstrap(Some("desktop")).unwrap();
        assert_eq!(bootstrap["openFiles"].as_array().unwrap().len(), 1);
        assert_eq!(
            bootstrap["recentFiles"].as_array().unwrap().len(),
            workspace::MAX_OPEN
        );
        assert_eq!(bootstrap["activePath"], "0.txt");
        assert_eq!(app.session.lock().unwrap().usage_except("no-project").0, 2);
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(
                app.config
                    .project_state(&canonical)
                    .unwrap()
                    .join("drafts.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["documents"].as_array().unwrap().len(), 1);
        assert_eq!(
            manifest["recent_paths"].as_array().unwrap().len(),
            workspace::MAX_OPEN
        );
    }

    #[test]
    fn project_switch_rejects_unsafe_transitions_before_stopping_the_terminal() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let next = tempfile::tempdir().unwrap();
        let old_session = app.session.lock().unwrap().session_id.clone();
        execute(&app, "desktop", 1, Command::TerminalStart { generation: 1 }).unwrap();
        let project = || next.path().to_string_lossy().into_owned();
        assert_eq!(
            execute(
                &app,
                "phone123",
                2,
                Command::OpenProject {
                    path: "relative".into(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "path"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: project(),
                    generation: 0
                }
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: "relative".into(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "path"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: root.path().join("missing").to_string_lossy().into_owned(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "workspace"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: root.path().join("test.txt").to_string_lossy().into_owned(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "workspace"
        );
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        let target_lock =
            workspace::Workspace::new(&canonical, app.config.project_state(&canonical)).unwrap();
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: project(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "workspace_busy"
        );
        drop(target_lock);
        let file = execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: None,
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: file["file"]["revision"].as_u64().unwrap(),
                content: "unsaved".into(),
                generation: 1,
            },
        )
        .unwrap();
        std::fs::write(root.path().join("test.txt"), "external").unwrap();
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::OpenProject {
                    path: project(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "unsaved"
        );
        assert!(
            app.session.lock().unwrap().workspace.documents()[0]
                .conflict
                .is_some()
        );
        let same = execute(
            &app,
            "desktop",
            1,
            Command::OpenProject {
                path: root.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(same["unchanged"], true);
        assert_eq!(app.session.lock().unwrap().session_id, old_session);
        assert!(app.terminal.snapshot().running);
        execute(
            &app,
            "desktop",
            1,
            Command::CloseFile {
                path: "test.txt".into(),
                discard: true,
                revision: Some(2),
                generation: 1,
            },
        )
        .unwrap();
        let switched = execute(
            &app,
            "desktop",
            1,
            Command::OpenProject {
                path: project(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(switched["generation"], 2);
        assert!(!app.terminal.snapshot().running);
        let session = app.session.lock().unwrap();
        assert_eq!(session.workspace.root, canonical);
        assert_ne!(session.session_id, old_session);
        assert_eq!(session.controller_id.as_deref(), Some("desktop"));
        assert!(session.tokens.contains_key(&token));
        assert_eq!(session.clients.len(), 2);
        assert!(session.workspace.documents().is_empty());
        drop(session);
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::CreateFile {
                    path: "queued.txt".into(),
                    content: "stale".into(),
                    generation: 1
                }
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert!(!next.path().join("queued.txt").exists());
    }
    #[test]
    fn project_switch_loads_isolated_recovery_and_broadcasts_a_new_identity() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let next = tempfile::tempdir().unwrap();
        std::fs::write(next.path().join("test.txt"), "next disk").unwrap();
        let canonical = std::fs::canonicalize(next.path()).unwrap();
        let mut recovery =
            workspace::Workspace::new(&canonical, app.config.project_state(&canonical)).unwrap();
        let file = recovery.open("test.txt").unwrap();
        recovery
            .edit("test.txt", file.revision, "next unsaved".into())
            .unwrap();
        recovery.select("test.txt").unwrap();
        drop(recovery);
        let mut events = app.events.subscribe();
        app.session.lock().unwrap().ai_context = Some(AiContext {
            path: "old.txt".into(),
            revision: 7,
        });
        execute(
            &app,
            "desktop",
            1,
            Command::OpenProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(events.try_recv().unwrap()["type"], "project_changed");
        let phone = app.bootstrap(Some("phone123")).unwrap();
        assert_eq!(phone["workspacePath"], canonical.to_string_lossy().as_ref());
        assert_eq!(phone["clientId"], "phone123");
        assert_eq!(phone["openFiles"][0]["content"], "next unsaved");
        assert_eq!(phone["activePath"], "test.txt");
        assert!(phone["aiContext"].is_null());
        assert_eq!(phone["pickerAvailable"], false);
        assert_eq!(
            std::fs::read_to_string(root.path().join("test.txt")).unwrap(),
            "original"
        );
        execute(
            &app,
            "desktop",
            1,
            Command::CloseFile {
                path: "test.txt".into(),
                discard: true,
                revision: Some(phone["openFiles"][0]["revision"].as_u64().unwrap()),
                generation: 2,
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::OpenProject {
                path: root.path().to_string_lossy().into_owned(),
                generation: 2,
            },
        )
        .unwrap();
        assert_eq!(
            app.bootstrap(Some("desktop")).unwrap()["workspacePath"],
            std::fs::canonicalize(root.path())
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(app.session.lock().unwrap().generation, 3);
    }
    #[test]
    fn paired_settings_are_shared_and_native_picker_remains_local_only() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let mut settings = app.ai.settings();
        settings.codex.model = Some("test-model".into());
        let configured = execute(
            &app,
            "phone123",
            2,
            Command::AiSettingsSet {
                settings: settings.clone(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(configured["settings"]["codex"]["model"], "test-model");
        assert!(execute(&app, "phone123", 2, Command::AiSettingsGet).is_ok());
        execute(&app, "phone123", 2, Command::ClaimControl).unwrap();
        for _ in 0..2 {
            assert_eq!(
                execute(
                    &app,
                    "phone123",
                    2,
                    Command::BrowseProject { generation: 1 }
                )
                .unwrap_err()
                .code,
                "picker_local_only"
            );
            execute(
                &app,
                "desktop",
                1,
                Command::AiSettingsSet {
                    settings: settings.clone(),
                    generation: 1,
                },
            )
            .unwrap();
        }
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::AiSettingsSet {
                    settings,
                    generation: 2,
                }
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert_eq!(app.session.lock().unwrap().generation, 1);
    }
    #[test]
    fn custom_state_directory_keeps_project_recovery_mapping_after_restart() {
        let (root, state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let first_root = app.session.lock().unwrap().workspace.root.clone();
        execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: None,
            },
        )
        .unwrap();
        let next = tempfile::tempdir().unwrap();
        std::fs::write(next.path().join("test.txt"), "next saved").unwrap();
        let second_root = std::fs::canonicalize(next.path()).unwrap();
        let mut resumed = Config {
            workspace: second_root.clone(),
            state_dir: Some(state.path().into()),
            ..config()
        };
        // Legacy hosts had only drafts.json, whose owner must remain the base owner.
        resumed.prepare_state(&second_root).unwrap();
        assert_eq!(resumed.state_owner.as_ref(), Some(&first_root));
        write_project_preference(&state.path().join("project-root.json"), &first_root).unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::OpenProject {
                path: second_root.to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let opened = execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: None,
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: opened["file"]["revision"].as_u64().unwrap(),
                content: "second project recovered draft".into(),
                generation: 2,
            },
        )
        .unwrap();
        let expected = app.config.project_state(&second_root);
        drop(app);
        // A resumed B host and an explicit A override resolve the same paths as before.
        resumed.prepare_state(&second_root).unwrap();
        assert_eq!(resumed.project_state(&second_root), expected);
        assert_eq!(
            resumed.project_state(&first_root),
            Some(state.path().to_owned())
        );
        let recovered =
            workspace::Workspace::new(&second_root, resumed.project_state(&second_root)).unwrap();
        assert_eq!(
            recovered.documents()[0].content,
            "second project recovered draft"
        );
        assert!(recovered.documents()[0].dirty);
        drop(recovered);
        let mut explicit = Config {
            workspace: first_root.clone(),
            state_dir: Some(state.path().into()),
            ..config()
        };
        explicit.prepare_state(&first_root).unwrap();
        let original =
            workspace::Workspace::new(&first_root, explicit.project_state(&first_root)).unwrap();
        assert_eq!(original.documents()[0].content, "original");
        assert_eq!(
            std::fs::read_to_string(root.path().join("test.txt")).unwrap(),
            "original"
        );
    }
    #[test]
    fn desktop_startup_remembers_the_opened_project_without_changing_cli_preferences() {
        let (_root, state, mut app, _token) = test_app();
        let preference = state.path().join("preferences/last-project.json");
        let previous = tempfile::tempdir().unwrap();
        let previous_root = std::fs::canonicalize(previous.path()).unwrap();
        write_project_preference(&preference, &previous_root).unwrap();
        Arc::get_mut(&mut app).unwrap().config.project_preference = Some(preference.clone());

        // A normal command-line launch does not replace the saved desktop choice.
        assert!(app.remember_desktop_startup_project().is_none());
        assert_eq!(read_project_preference(&preference), Some(previous_root));

        Arc::get_mut(&mut app).unwrap().config.desktop = true;
        assert!(app.remember_desktop_startup_project().is_none());
        assert_eq!(
            read_project_preference(&preference),
            Some(app.session.lock().unwrap().workspace.root.clone())
        );

        // Preference write failures are reported without rejecting an open project.
        let blocked_directory = state.path().join("not-a-directory");
        std::fs::write(&blocked_directory, b"occupied").unwrap();
        Arc::get_mut(&mut app).unwrap().config.project_preference =
            Some(blocked_directory.join("last-project.json"));
        let warning = app.remember_desktop_startup_project().unwrap();
        assert!(warning.contains("preference could not be saved"));
        assert!(app.bootstrap(None).is_ok());
    }
    #[test]
    fn project_preferences_are_bounded_private_and_ignore_bad_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let preference = directory.path().join("preferences/last-project.json");
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        write_project_preference(&preference, &canonical).unwrap();
        assert_eq!(read_project_preference(&preference), Some(canonical));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&preference).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(preference.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
        std::fs::write(&preference, r#"{"workspace":"relative"}"#).unwrap();
        assert!(read_project_preference(&preference).is_none());
        std::fs::write(&preference, vec![b'x'; 8193]).unwrap();
        assert!(read_project_preference(&preference).is_none());
        #[cfg(unix)]
        {
            std::fs::remove_file(&preference).unwrap();
            std::os::unix::fs::symlink(root.path().join("missing"), &preference).unwrap();
            assert!(read_project_preference(&preference).is_none());
            std::fs::remove_file(&preference).unwrap();
            let path = std::ffi::CString::new(preference.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            assert!(read_project_record(&preference).is_err());
        }
    }
    #[tokio::test]
    async fn bootstrap_requires_auth_and_sets_a_private_cookie() {
        let (_root, _state, app, token) = test_app();
        let unauthenticated = bootstrap(
            State(app.clone()),
            ConnectInfo("127.0.0.1:12345".parse().unwrap()),
            own_headers(),
            Query(ConnectionQuery::default()),
        )
        .await;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let mut headers = own_headers();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let response = bootstrap(
            State(app.clone()),
            ConnectInfo("127.0.0.1:12345".parse().unwrap()),
            headers,
            Query(ConnectionQuery::default()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(!cookie.contains("Secure"));
        let mut headers = own_headers();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(cookie.split(';').next().unwrap()).unwrap(),
        );
        assert_eq!(
            bootstrap(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                headers.clone(),
                Query(ConnectionQuery::default())
            )
            .await
            .status(),
            StatusCode::OK
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        assert_eq!(
            bootstrap(
                State(app),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                headers,
                Query(ConnectionQuery::default())
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn pairing_is_single_use_origin_checked_and_attempt_limited() {
        let (_root, _state, app, token) = test_app();
        let remote = ConnectInfo("127.0.0.1:12345".parse().unwrap());
        app.session.lock().unwrap().pairing = Some(Pairing {
            code: "123456".into(),
            invite: "a".repeat(64),
            origin: "http://127.0.0.1:7410".into(),
            issuer_token: token.clone(),
            credential_created: None,
            expires: Instant::now() + Duration::from_secs(120),
            attempts: 0,
        });
        let mut wrong_origin = own_headers();
        wrong_origin.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example"),
        );
        assert_eq!(
            pair(
                State(app.clone()),
                remote,
                wrong_origin,
                Json(PairRequest {
                    password: None,
                    code: "123456".into(),
                    invite: Some("a".repeat(64)),
                })
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let paired = pair(
            State(app.clone()),
            remote,
            own_headers(),
            Json(PairRequest {
                password: None,
                code: "123456".into(),
                invite: Some("a".repeat(64)),
            }),
        )
        .await;
        assert_eq!(paired.status(), StatusCode::OK);
        assert!(
            paired.headers()[header::SET_COOKIE]
                .to_str()
                .unwrap()
                .contains("HttpOnly")
        );
        assert_eq!(app.session.lock().unwrap().tokens.len(), 2);
        assert_eq!(
            pair(
                State(app.clone()),
                remote,
                own_headers(),
                Json(PairRequest {
                    password: None,
                    code: "123456".into(),
                    invite: Some("a".repeat(64)),
                })
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        app.session.lock().unwrap().pairing = Some(Pairing {
            code: "654321".into(),
            invite: "a".repeat(64),
            origin: "http://127.0.0.1:7410".into(),
            issuer_token: token.clone(),
            credential_created: None,
            expires: Instant::now() + Duration::from_secs(120),
            attempts: 0,
        });
        for _ in 0..5 {
            assert_eq!(
                pair(
                    State(app.clone()),
                    remote,
                    own_headers(),
                    Json(PairRequest {
                        password: None,
                        code: "111111".into(),
                        invite: Some("a".repeat(64)),
                    })
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(app.session.lock().unwrap().pairing.is_none());
        assert_eq!(
            pair(
                State(app),
                remote,
                own_headers(),
                Json(PairRequest {
                    password: None,
                    code: "654321".into(),
                    invite: Some("a".repeat(64)),
                })
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn untrusted_invites_never_burn_codes_or_lock_out_a_proxy_peer() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let pairing = execute(
            &app,
            "desktop",
            1,
            Command::PairCreate {
                generation: 1,
                origin: None,
            },
        )
        .unwrap();
        for attempt in 0..100 {
            let invite = match attempt % 3 {
                0 => None,
                1 => Some("malformed".into()),
                _ => Some("f".repeat(64)),
            };
            let response = pair(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                own_headers(),
                Json(PairRequest {
                    password: None,
                    code: pairing["code"].as_str().unwrap().into(),
                    invite,
                }),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .pairing
                .as_ref()
                .unwrap()
                .attempts,
            0
        );
        let response = pair(
            State(app.clone()),
            ConnectInfo("127.0.0.1:12345".parse().unwrap()),
            own_headers(),
            Json(PairRequest {
                password: None,
                code: pairing["code"].as_str().unwrap().into(),
                invite: Some(pairing["invite"].as_str().unwrap().into()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn invitations_rotate_and_are_bound_to_the_exact_target_origin() {
        let (_root, _state, mut app, token) = test_app();
        Arc::get_mut(&mut app).unwrap().config.origin = Some("https://nimlo.example".into());
        connect_test_devices(&app, &token);
        let create = || Command::PairCreate {
            generation: 1,
            origin: Some("https://nimlo.example".into()),
        };
        let first = execute(&app, "desktop", 1, create()).unwrap();
        let second = execute(&app, "desktop", 1, create()).unwrap();
        assert_ne!(first["invite"], second["invite"]);
        let request = |value: &Value| PairRequest {
            password: None,
            code: value["code"].as_str().unwrap().into(),
            invite: Some(value["invite"].as_str().unwrap().into()),
        };
        assert_eq!(
            pair(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                own_headers(),
                Json(request(&second))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut public = HeaderMap::new();
        public.insert(header::HOST, HeaderValue::from_static("nimlo.example"));
        public.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://nimlo.example"),
        );
        assert_eq!(
            pair(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                public.clone(),
                Json(request(&first))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .pairing
                .as_ref()
                .unwrap()
                .attempts,
            0
        );
        let response = pair(
            State(app.clone()),
            ConnectInfo("127.0.0.1:12345".parse().unwrap()),
            public,
            Json(request(&second)),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.starts_with("__Host-nimlo_session="));
        assert!(cookie.contains("; Secure"));
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::PairCreate {
                    generation: 1,
                    origin: Some("https://attacker.example".into())
                }
            )
            .unwrap_err()
            .code,
            "origin"
        );
        let expired = execute(&app, "desktop", 1, create()).unwrap();
        app.session
            .lock()
            .unwrap()
            .pairing
            .as_mut()
            .unwrap()
            .expires = Instant::now();
        let mut public = HeaderMap::new();
        public.insert(header::HOST, HeaderValue::from_static("nimlo.example"));
        public.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://nimlo.example"),
        );
        assert_eq!(
            pair(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                public,
                Json(request(&expired))
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(app.session.lock().unwrap().pairing.is_none());
    }
    #[tokio::test]
    async fn expired_records_do_not_exhaust_pairing_capacity() {
        let (_root, _state, app, root_token) = test_app();
        connect_test_devices(&app, &root_token);
        let old = Instant::now() - auth::IDLE_TIMEOUT;
        for _ in 1..MAX_TOKENS {
            app.session.lock().unwrap().tokens.insert(
                secret(),
                auth::TokenRecord::paired("http://127.0.0.1:7410".into(), old),
            );
        }
        let pairing = execute(
            &app,
            "desktop",
            1,
            Command::PairCreate {
                generation: 1,
                origin: None,
            },
        )
        .unwrap();
        let response = pair(
            State(app.clone()),
            ConnectInfo("127.0.0.1:12345".parse().unwrap()),
            own_headers(),
            Json(PairRequest {
                password: None,
                code: pairing["code"].as_str().unwrap().into(),
                invite: Some(pairing["invite"].as_str().unwrap().into()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let session = app.session.lock().unwrap();
        assert_eq!(session.tokens.len(), 2);
        assert!(session.tokens.get(&root_token).unwrap().is_host);
    }
    #[test]
    fn paired_devices_cannot_issue_invitations_or_renew_credentials() {
        let (_root, _state, app, root_token) = test_app();
        connect_test_devices(&app, &root_token);
        let token = paired_test_client(&app, "paired123", 10, "http://127.0.0.1:7410");
        let created = Instant::now() - auth::ABSOLUTE_TIMEOUT + Duration::from_secs(60);
        app.session
            .lock()
            .unwrap()
            .tokens
            .get_mut(&token)
            .unwrap()
            .created = created;
        assert_eq!(
            execute(
                &app,
                "paired123",
                10,
                Command::PairCreate {
                    generation: 1,
                    origin: None
                }
            )
            .unwrap_err()
            .code,
            "permission_denied"
        );
        assert!(app.session.lock().unwrap().pairing.is_none());
        execute(&app, "paired123", 10, Command::AiSettingsGet).unwrap();
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .tokens
                .get(&token)
                .unwrap()
                .created,
            created
        );
        app.session
            .lock()
            .unwrap()
            .tokens
            .get_mut(&token)
            .unwrap()
            .last_activity = Instant::now() - auth::IDLE_TIMEOUT;
        assert_eq!(
            execute(&app, "paired123", 10, Command::Ping)
                .unwrap_err()
                .code,
            "auth"
        );
        assert!(
            execute(
                &app,
                "desktop",
                1,
                Command::PairCreate {
                    generation: 1,
                    origin: None
                }
            )
            .is_ok()
        );
    }
    #[test]
    fn device_access_is_host_managed_live_and_shared_by_credential() {
        let (_root, state, app, root_token) = test_app();
        connect_test_devices(&app, &root_token);
        let token = paired_test_client(&app, "paired123", 10, "http://127.0.0.1:7410");
        {
            let mut session = app.session.lock().unwrap();
            let mut tab = session.clients["paired123"].clone();
            tab.id = "pairedtab".into();
            tab.connection = 11;
            session.clients.insert(tab.id.clone(), tab);
        }
        let settings = access::AccessSettings {
            allow_devices: true,
            permissions: DevicePermissions {
                edit_files: false,
                terminal: true,
                ai: false,
            },
        };
        assert_eq!(
            execute(
                &app,
                "paired123",
                10,
                Command::SessionAccessSet {
                    generation: 1,
                    settings: settings.clone(),
                    password: None
                }
            )
            .unwrap_err()
            .code,
            "permission_denied"
        );
        assert!(!state.path().join("device-access.json").exists());
        execute(
            &app,
            "desktop",
            1,
            Command::SessionAccessSet {
                generation: 1,
                settings: settings.clone(),
                password: None,
            },
        )
        .unwrap();
        assert_eq!(
            AccessPolicy::load(Some(&state.path().join("device-access.json")))
                .settings
                .permissions,
            settings.permissions
        );
        let document = execute(
            &app,
            "paired123",
            10,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        let revision = document["file"]["revision"].as_u64().unwrap();
        for command in [
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: revision,
                content: "blocked".into(),
                generation: 1,
            },
            Command::PatchFile {
                path: "test.txt".into(),
                base_revision: revision,
                start: 0,
                delete_count: 0,
                insert: "blocked".into(),
                generation: 1,
            },
            Command::SaveFile {
                path: "test.txt".into(),
                revision,
                generation: 1,
            },
            Command::UndoFile {
                path: "test.txt".into(),
                revision,
                generation: 1,
            },
            Command::RedoFile {
                path: "test.txt".into(),
                revision,
                generation: 1,
            },
            Command::CreateFile {
                path: "blocked.txt".into(),
                content: String::new(),
                generation: 1,
            },
            Command::CloseFile {
                path: "test.txt".into(),
                discard: true,
                revision: Some(revision),
                generation: 1,
            },
            Command::AiStatus,
            Command::AiSettingsGet,
            Command::AiAuthRefresh { generation: 1 },
            Command::AiSettingsSet {
                settings: app.ai.settings(),
                generation: 1,
            },
            Command::OpenProject {
                path: "/tmp".into(),
                generation: 1,
            },
            Command::AddProject {
                path: "/tmp".into(),
                generation: 1,
            },
            Command::BrowseProject { generation: 1 },
            Command::RevokeAllDevices { generation: 1 },
            Command::DevicePermissionsSet {
                target_client_id: "paired123".into(),
                permissions: DevicePermissions::FULL,
                generation: 1,
            },
            Command::RevokeDevice {
                target_client_id: "desktop".into(),
                generation: 1,
            },
        ] {
            assert_eq!(
                execute(&app, "paired123", 10, command).unwrap_err().code,
                "permission_denied"
            );
        }
        assert!(
            execute(
                &app,
                "paired123",
                10,
                Command::AiOpenFile {
                    target: "test.txt:2".into()
                }
            )
            .is_ok()
        );
        assert!(
            execute(
                &app,
                "paired123",
                10,
                Command::TerminalHistory { limit: 10 }
            )
            .is_ok()
        );
        execute(
            &app,
            "desktop",
            1,
            Command::DevicePermissionsSet {
                target_client_id: "paired123".into(),
                permissions: DevicePermissions::NONE,
                generation: 1,
            },
        )
        .unwrap();
        for (id, connection) in [("paired123", 10), ("pairedtab", 11)] {
            assert_eq!(
                execute(&app, id, connection, Command::TerminalHistory { limit: 10 })
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
            assert_eq!(
                app.bootstrap(Some(id)).unwrap()["permissions"],
                json!(DevicePermissions::NONE)
            );
        }
        assert_eq!(
            app.session.lock().unwrap().tokens[&token].permissions,
            DevicePermissions::NONE
        );
        assert_eq!(
            app.bootstrap(Some("desktop")).unwrap()["permissions"],
            json!(DevicePermissions::FULL)
        );
        let settings = access::AccessSettings {
            allow_devices: false,
            permissions: DevicePermissions::FULL,
        };
        execute(
            &app,
            "desktop",
            1,
            Command::SessionAccessSet {
                generation: 1,
                settings,
                password: None,
            },
        )
        .unwrap();
        assert_eq!(app.session.lock().unwrap().tokens.len(), 1);
        assert!(execute(&app, "paired123", 10, Command::Ping).is_err());
        assert!(execute(&app, "desktop", 1, Command::Ping).is_ok());
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::PairCreate {
                    generation: 1,
                    origin: None
                }
            )
            .unwrap_err()
            .code,
            "devices_disabled"
        );
    }
    #[test]
    fn ai_execution_requires_editor_and_terminal_permissions_but_decline_remains_available() {
        let (_root, _state, app, root_token) = test_app();
        connect_test_devices(&app, &root_token);
        let token = paired_test_client(&app, "paired123", 10, "http://127.0.0.1:7410");
        for permissions in [
            DevicePermissions {
                edit_files: false,
                terminal: true,
                ai: true,
            },
            DevicePermissions {
                edit_files: true,
                terminal: false,
                ai: true,
            },
        ] {
            app.session
                .lock()
                .unwrap()
                .tokens
                .get_mut(&token)
                .unwrap()
                .permissions = permissions;
            for command in [
                Command::AiStart {
                    provider: "codex".into(),
                    prompt: "blocked".into(),
                    path: None,
                    generation: 1,
                },
                Command::AiApprove {
                    id: "missing".into(),
                    choice: "accept".into(),
                    generation: 1,
                },
                Command::AiApprove {
                    id: "missing".into(),
                    choice: "allow_network_once".into(),
                    generation: 1,
                },
            ] {
                assert_eq!(
                    execute(&app, "paired123", 10, command).unwrap_err().code,
                    "permission_denied"
                );
            }
            let session = app.session.lock().unwrap();
            assert!(
                session
                    .authorize_command(
                        "paired123",
                        &Command::AiApprove {
                            id: "missing".into(),
                            choice: "decline".into(),
                            generation: 1
                        }
                    )
                    .is_ok()
            );
            assert!(
                session
                    .authorize_command("paired123", &Command::AiCancel { generation: 1 })
                    .is_ok()
            );
        }
    }
    #[tokio::test]
    async fn authentication_rejects_root_proxy_replay_token_urls_and_cross_origin_sessions() {
        let (_root, _state, mut app, root_token) = test_app();
        Arc::get_mut(&mut app).unwrap().config.origin = Some("https://nimlo.example".into());
        let loopback = "127.0.0.1:12345".parse().unwrap();
        let peer = "192.168.1.4:12345".parse().unwrap();
        let mut local = own_headers();
        local.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {root_token}")).unwrap(),
        );
        assert!(
            app.token(&local, loopback, "http://127.0.0.1:7410")
                .is_some()
        );
        assert!(app.token(&local, peer, "http://127.0.0.1:7410").is_none());
        local.insert(
            "x-forwarded-host",
            HeaderValue::from_static("nimlo.example"),
        );
        assert!(
            app.token(&local, loopback, "http://127.0.0.1:7410")
                .is_none()
        );
        let mut public = HeaderMap::new();
        public.insert(header::HOST, HeaderValue::from_static("nimlo.example"));
        public.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://nimlo.example"),
        );
        public.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {root_token}")).unwrap(),
        );
        assert!(
            app.token(&public, loopback, "https://nimlo.example")
                .is_none()
        );
        let token = paired_test_client(&app, "paired123", 10, "https://nimlo.example");
        public.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert!(app.token(&public, peer, "https://nimlo.example").is_some());
        local.remove("x-forwarded-host");
        local.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert!(
            app.token(&local, loopback, "http://127.0.0.1:7410")
                .is_none()
        );
        public.remove(header::AUTHORIZATION);
        public.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("nimlo_session={token}")).unwrap(),
        );
        assert!(app.token(&public, peer, "https://nimlo.example").is_none());
        public.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("__Host-nimlo_session={token}")).unwrap(),
        );
        assert!(app.token(&public, peer, "https://nimlo.example").is_some());
        let query = serde_json::from_value::<ConnectionQuery>(json!({"token":root_token})).unwrap();
        let response = bootstrap(
            State(app),
            ConnectInfo(loopback),
            own_headers(),
            Query(query),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    #[tokio::test]
    async fn only_authenticated_application_commands_refresh_idle_expiry() {
        let (_root, _state, app, _root_token) = test_app();
        let token = paired_test_client(&app, "paired123", 10, "http://127.0.0.1:7410");
        let now = Instant::now();
        let old_activity = now - Duration::from_secs(600);
        app.session
            .lock()
            .unwrap()
            .tokens
            .get_mut(&token)
            .unwrap()
            .last_activity = old_activity;
        execute(&app, "paired123", 10, Command::Ping).unwrap();
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .tokens
                .get(&token)
                .unwrap()
                .last_activity,
            old_activity
        );
        let mut headers = own_headers();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert_eq!(
            bootstrap(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                headers.clone(),
                Query(ConnectionQuery::default())
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .tokens
                .get(&token)
                .unwrap()
                .last_activity,
            old_activity
        );
        execute(
            &app,
            "paired123",
            10,
            Command::ListFiles {
                directory: String::new(),
            },
        )
        .unwrap();
        assert!(
            app.session
                .lock()
                .unwrap()
                .tokens
                .get(&token)
                .unwrap()
                .last_activity
                >= now
        );
        {
            let mut session = app.session.lock().unwrap();
            session.tokens.get_mut(&token).unwrap().created = now - auth::ABSOLUTE_TIMEOUT;
            assert_eq!(
                session
                    .authorize_connection_at("paired123", 10, now)
                    .unwrap_err()
                    .code,
                "auth"
            );
            assert_eq!(
                session.touch("paired123", 10, now).unwrap_err().code,
                "auth"
            );
        }
        assert!(app.resync_events("paired123", 10).is_err());
        assert_eq!(
            execute(
                &app,
                "paired123",
                10,
                Command::ListFiles {
                    directory: String::new()
                }
            )
            .unwrap_err()
            .code,
            "auth"
        );
        assert_eq!(
            bootstrap(
                State(app.clone()),
                ConnectInfo("127.0.0.1:12345".parse().unwrap()),
                headers,
                Query(ConnectionQuery::default())
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(app.session.lock().unwrap().prune_expired(now));
    }
    #[test]
    fn revocation_removes_all_token_tabs_and_invites_but_protects_the_host() {
        let (_root, _state, app, root_token) = test_app();
        connect_test_devices(&app, &root_token);
        let token = paired_test_client(&app, "paired123", 10, "http://127.0.0.1:7410");
        {
            let mut session = app.session.lock().unwrap();
            let mut tab = session.clients.get("paired123").unwrap().clone();
            tab.id = "pairedtab".into();
            tab.connection = 11;
            session.clients.insert(tab.id.clone(), tab);
        }
        execute(
            &app,
            "desktop",
            1,
            Command::PairCreate {
                generation: 1,
                origin: None,
            },
        )
        .unwrap();
        let notifications = app.auth_changed.subscribe();
        let mut events = app.events.subscribe();
        execute(
            &app,
            "desktop",
            1,
            Command::RevokeDevice {
                generation: 1,
                target_client_id: "paired123".into(),
            },
        )
        .unwrap();
        assert!(notifications.has_changed().unwrap());
        assert_eq!(events.try_recv().unwrap()["type"], "pairing_cancelled");
        {
            let session = app.session.lock().unwrap();
            assert!(!session.tokens.contains_key(&token));
            assert!(!session.clients.contains_key("paired123"));
            assert!(!session.clients.contains_key("pairedtab"));
            assert!(session.tokens.get(&root_token).unwrap().is_host);
            assert!(session.pairing.is_none());
            assert!(session.authorize_connection("desktop", 1).is_ok());
        }
        assert!(app.resync_events("paired123", 10).is_err());
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::RevokeDevice {
                    generation: 1,
                    target_client_id: "desktop".into()
                }
            )
            .unwrap_err()
            .code,
            "host_session"
        );
        let new_token = paired_test_client(&app, "paired123", 12, "http://127.0.0.1:7410");
        assert_ne!(token, new_token);
        execute(
            &app,
            "paired123",
            12,
            Command::RevokeAllDevices { generation: 1 },
        )
        .unwrap_err();
        assert!(app.session.lock().unwrap().tokens.contains_key(&new_token));
        execute(
            &app,
            "desktop",
            1,
            Command::RevokeAllDevices { generation: 1 },
        )
        .unwrap();
        let session = app.session.lock().unwrap();
        assert_eq!(session.tokens.len(), 1);
        assert!(session.authorize_connection("desktop", 1).is_ok());
        assert!(!session.clients.contains_key("paired123"));
    }
    #[test]
    fn paired_devices_share_edits_without_handoff_and_reject_stale_revisions() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let opened = execute(
            &app,
            "phone123",
            2,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        let revision = opened["file"]["revision"].as_u64().unwrap();
        let mut events = app.events.subscribe();
        let edited = execute(
            &app,
            "phone123",
            2,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: revision,
                content: "phone unsaved work".into(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(edited["sourceClientId"], "phone123");
        assert_eq!(events.try_recv().unwrap()["sourceClientId"], "phone123");
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::EditFile {
                    path: "test.txt".into(),
                    base_revision: revision,
                    content: "stale desktop edit".into(),
                    generation: 1,
                }
            )
            .unwrap_err()
            .code,
            "stale_revision"
        );
        execute(&app, "phone123", 2, Command::ClaimControl).unwrap();
        let desktop = execute(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: edited["file"]["revision"].as_u64().unwrap(),
                content: "desktop shared work".into(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(desktop["sourceClientId"], "desktop");
        execute(
            &app,
            "phone123",
            2,
            Command::SaveFile {
                path: "test.txt".into(),
                revision: desktop["file"]["revision"].as_u64().unwrap(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.path().join("test.txt")).unwrap(),
            "desktop shared work"
        );
        let snapshot = app.bootstrap(Some("phone123")).unwrap();
        assert_eq!(snapshot["access"], "shared");
        assert_eq!(snapshot["activePath"], "test.txt");
        assert_eq!(snapshot["controllerId"], "phone123");
        assert_eq!(snapshot["generation"], 1);
        execute(
            &app,
            "phone123",
            2,
            Command::CreateFile {
                path: "phone.txt".into(),
                content: "created on phone".into(),
                generation: 1,
            },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(1),
            },
        )
        .unwrap();
        assert_eq!(
            app.session.lock().unwrap().workspace.active_path.as_deref(),
            Some("test.txt")
        );
    }

    #[test]
    fn discarding_shared_work_requires_the_current_file_incarnation() {
        let (root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let open = || Command::OpenFile {
            path: "test.txt".into(),
            generation: Some(1),
        };
        let opened = execute(&app, "desktop", 1, open()).unwrap();
        let original_revision = opened["file"]["revision"].as_u64().unwrap();
        let edited = execute(
            &app,
            "phone123",
            2,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: original_revision,
                content: "preserve this work".into(),
                generation: 1,
            },
        )
        .unwrap();
        let revision = edited["file"]["revision"].as_u64().unwrap();
        let close = |revision| Command::CloseFile {
            path: "test.txt".into(),
            discard: true,
            revision,
            generation: 1,
        };
        assert_eq!(
            execute(&app, "desktop", 1, close(None)).unwrap_err().code,
            "revision_required"
        );
        assert_eq!(
            execute(&app, "desktop", 1, close(Some(original_revision)))
                .unwrap_err()
                .code,
            "stale_revision"
        );
        std::fs::remove_file(root.path().join("test.txt")).unwrap();
        app.session.lock().unwrap().workspace.refresh().unwrap();
        // Discard remains available when disk disappeared; it reads the shared buffer.
        execute(&app, "phone123", 2, close(Some(revision))).unwrap();
        std::fs::write(root.path().join("test.txt"), "recreated disk").unwrap();
        let reopened = execute(&app, "phone123", 2, open()).unwrap();
        assert!(reopened["file"]["revision"].as_u64().unwrap() > revision);
        assert_eq!(
            execute(&app, "desktop", 1, close(Some(revision)))
                .unwrap_err()
                .code,
            "stale_revision"
        );
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::EditFile {
                    path: "test.txt".into(),
                    base_revision: original_revision,
                    content: "delayed pre-close edit".into(),
                    generation: 1,
                }
            )
            .unwrap_err()
            .code,
            "stale_revision"
        );
        assert_eq!(
            app.session
                .lock()
                .unwrap()
                .workspace
                .document("test.txt")
                .unwrap()
                .content,
            "recreated disk"
        );
    }

    #[test]
    fn session_resync_discards_old_close_events_and_starts_after_its_snapshot() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let mut stale_events = app.events.subscribe();
        let open = || Command::OpenFile {
            path: "test.txt".into(),
            generation: Some(1),
        };
        let original = execute(&app, "desktop", 1, open()).unwrap();
        execute(
            &app,
            "phone123",
            2,
            Command::CloseFile {
                path: "test.txt".into(),
                discard: false,
                revision: Some(original["file"]["revision"].as_u64().unwrap()),
                generation: 1,
            },
        )
        .unwrap();
        let reopened = execute(&app, "phone123", 2, open()).unwrap();
        for _ in 0..20 {
            execute(&app, "phone123", 2, Command::ClaimControl).unwrap();
        }
        assert!(matches!(
            stale_events.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
        let (snapshot, mut events) = app.resync_events("desktop", 1).unwrap();
        assert_eq!(
            snapshot["openFiles"][0]["revision"],
            reopened["file"]["revision"]
        );
        assert_eq!(snapshot["activePath"], "test.txt");
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let changed = execute(
            &app,
            "desktop",
            1,
            Command::EditFile {
                path: "test.txt".into(),
                base_revision: reopened["file"]["revision"].as_u64().unwrap(),
                content: "after snapshot".into(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(*events.try_recv().unwrap(), changed);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn correlated_project_bootstrap_cannot_replay_a_removed_root_or_old_generation() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        let primary_id = app.session.lock().unwrap().primary_id();
        let next = tempfile::tempdir().unwrap();
        let attached = execute(
            &app,
            "phone123",
            2,
            Command::AddProject {
                path: next.path().to_string_lossy().into_owned(),
                generation: 1,
            },
        )
        .unwrap();
        let selected_id = attached["projectId"].as_str().unwrap().to_owned();
        let mut stale_response = execute(
            &app,
            "desktop",
            1,
            Command::SelectProject {
                target_project_id: selected_id.clone(),
                generation: 1,
            },
        )
        .unwrap();
        stale_response["requestId"] = json!("choose-second");
        assert_eq!(stale_response["projectId"], selected_id);
        assert_eq!(stale_response["generation"], 2);

        // A peer removes B during this request's queued event drain. The newer
        // fallback snapshot can already have reached the requesting browser.
        execute(
            &app,
            "phone123",
            2,
            Command::RemoveProject {
                target_project_id: selected_id,
                generation: 2,
            },
        )
        .unwrap();
        let already_sent = app.bootstrap(Some("desktop")).unwrap();
        assert_eq!(already_sent["projectId"], primary_id);
        assert_eq!(already_sent["generation"], 3);
        let (reply, mut events) = app
            .correlated_bootstrap("desktop", 1, stale_response)
            .unwrap();
        assert_eq!(reply["requestId"], "choose-second");
        assert_eq!(reply["projectId"], already_sent["projectId"]);
        assert_eq!(reply["generation"], already_sent["generation"]);
        assert_eq!(reply["projects"], already_sent["projects"]);
        assert_eq!(reply["projects"].as_array().unwrap().len(), 1);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let document = execute(
            &app,
            "desktop",
            1,
            Command::OpenFile {
                path: "test.txt".into(),
                generation: Some(3),
            },
        )
        .unwrap();
        assert_eq!(*events.try_recv().unwrap(), document);
        app.session
            .lock()
            .unwrap()
            .clients
            .get_mut("desktop")
            .unwrap()
            .connected = false;
        assert!(app.correlated_bootstrap("desktop", 1, reply).is_err());
    }

    #[test]
    fn terminal_input_changes_only_viewport_ownership_and_other_resizes_are_ignored() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        execute(
            &app,
            "phone123",
            2,
            Command::TerminalStart { generation: 1 },
        )
        .unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::TerminalResize {
                cols: 90,
                rows: 30,
                generation: 1,
            },
        )
        .unwrap();
        let ignored = execute(
            &app,
            "phone123",
            2,
            Command::TerminalResize {
                cols: 40,
                rows: 12,
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(ignored["ignored"], true);
        assert_eq!(app.terminal.snapshot().cols, 90);
        let before_generation = app.session.lock().unwrap().generation;
        execute(
            &app,
            "phone123",
            2,
            Command::TerminalInput {
                data: "
"
                .into(),
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(
            app.session.lock().unwrap().controller_id.as_deref(),
            Some("phone123")
        );
        assert_eq!(app.session.lock().unwrap().generation, before_generation);
        execute(
            &app,
            "phone123",
            2,
            Command::TerminalResize {
                cols: 42,
                rows: 14,
                generation: 1,
            },
        )
        .unwrap();
        assert_eq!(app.terminal.snapshot().cols, 42);
        assert_eq!(
            execute(
                &app,
                "desktop",
                1,
                Command::TerminalResize {
                    cols: 110,
                    rows: 35,
                    generation: 1
                }
            )
            .unwrap()["ignored"],
            true
        );
        assert_eq!(app.terminal.snapshot().cols, 42);
        execute(
            &app,
            "desktop",
            1,
            Command::CreateFile {
                path: "pc.txt".into(),
                content: "still writable".into(),
                generation: 1,
            },
        )
        .unwrap();
        execute(
            &app,
            "phone123",
            2,
            Command::ReleaseControl { generation: 1 },
        )
        .unwrap();
        assert_eq!(app.session.lock().unwrap().generation, 1);
        execute(&app, "desktop", 1, Command::RequestControl).unwrap();
        assert_eq!(
            app.session.lock().unwrap().controller_id.as_deref(),
            Some("desktop")
        );
        execute(&app, "phone123", 2, Command::TerminalStop { generation: 1 }).unwrap();
    }

    #[test]
    fn rejected_ai_start_keeps_the_previous_shared_review_context() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        {
            let mut session = app.session.lock().unwrap();
            session.ai_context = Some(AiContext {
                path: "previous.rs".into(),
                revision: 7,
            });
        }
        let rejected = execute(
            &app,
            "phone123",
            2,
            Command::AiStart {
                provider: "unknown-provider".into(),
                prompt: "test".into(),
                path: Some("test.txt".into()),
                generation: 1,
            },
        );
        assert_eq!(rejected.unwrap_err().code, "ai");
        let snapshot = app.bootstrap(Some("desktop")).unwrap();
        assert_eq!(
            snapshot["aiContext"],
            json!({"path":"previous.rs","revision":7})
        );
    }
    #[test]
    fn rejects_dns_rebinding_and_cross_origin() {
        let config = config();
        assert!(config.accepts_local_host("127.0.0.1:7410"));
        assert!(config.accepts_local_host("localhost:7410"));
        assert!(!config.accepts_local_host("attacker.example:7410"));
        assert!(!config.accepts_local_host("192.168.1.5:7410"));
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:7410"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        assert!(!config.accepts_headers(&headers, true, None));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:7410"),
        );
        assert!(config.accepts_headers(&headers, true, None));
        headers.remove(header::ORIGIN);
        assert!(!config.accepts_headers(&headers, true, None));
    }
    #[test]
    fn public_and_local_authorities_require_their_own_origins() {
        let mut config = config();
        config.listen = "0.0.0.0:7410".parse().unwrap();
        config.connect_urls.push("http://192.168.1.5:7410".into());
        config.origin = Some("https://nimlo.example.ts.net".into());
        let tunnel = "https://example-random.trycloudflare.com";
        let authorities = [
            ("127.0.0.1:7410", "http://127.0.0.1:7410"),
            ("localhost:7410", "http://localhost:7410"),
            ("192.168.1.5:7410", "http://192.168.1.5:7410"),
            ("nimlo.example.ts.net", "https://nimlo.example.ts.net"),
            ("example-random.trycloudflare.com", tunnel),
        ];
        for (host, expected) in authorities {
            for (_, origin) in authorities {
                let mut headers = HeaderMap::new();
                headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
                headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
                assert_eq!(
                    config.accepts_headers(&headers, true, Some(tunnel)),
                    expected == origin,
                    "{host} with {origin}"
                );
            }
        }
        assert_eq!(
            config.expected_origin("example-random.trycloudflare.com", None),
            None
        );
        assert_eq!(
            config.expected_origin("other.trycloudflare.com", Some(tunnel)),
            None
        );
        assert_eq!(
            config.expected_origin("nimlo.example.ts.net.attacker.test", Some(tunnel)),
            None
        );
        assert_eq!(
            config.expected_origin("192.168.1.6:7410", Some(tunnel)),
            None
        );
    }

    #[test]
    fn forwarded_markers_never_grant_local_picker_or_change_cookie_security() {
        let (_root, _state, mut app, token) = test_app();
        Arc::get_mut(&mut app).unwrap().config.origin = Some("https://nimlo.example.ts.net".into());
        let mut headers = own_headers();
        assert!(app.config.local_headers(&headers));
        assert!(
            !app.cookie(&token, &app.accepted_origin(&headers, true).unwrap())
                .contains("Secure")
        );
        for marker in [
            "forwarded",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-for",
            "cf-connecting-ip",
            "cf-ray",
            "x-real-ip",
        ] {
            headers.insert(marker, HeaderValue::from_static("https"));
            assert!(!app.config.local_headers(&headers));
            assert!(
                !app.cookie(&token, &app.accepted_origin(&headers, true).unwrap())
                    .contains("Secure")
            );
            headers.remove(marker);
        }
        headers.insert(
            header::HOST,
            HeaderValue::from_static("nimlo.example.ts.net"),
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://nimlo.example.ts.net"),
        );
        assert!(app.accepts_headers(&headers, true));
        assert!(!app.config.local_headers(&headers));
        assert!(
            app.cookie(&token, &app.accepted_origin(&headers, true).unwrap())
                .contains("; Secure")
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
        assert!(
            app.cookie(&token, &app.accepted_origin(&headers, true).unwrap())
                .contains("; Secure")
        );
    }

    #[test]
    fn duplicate_host_and_origin_headers_are_rejected() {
        let config = config();
        let mut headers = own_headers();
        headers.append(header::HOST, HeaderValue::from_static("127.0.0.1:7410"));
        assert!(!config.accepts_headers(&headers, true, None));
        let mut headers = own_headers();
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:7410"),
        );
        assert!(!config.accepts_headers(&headers, true, None));
    }

    #[tokio::test]
    async fn configured_internet_preserves_local_bootstrap_and_does_not_spawn_a_tunnel() {
        let (_root, _state, mut app, token) = test_app();
        Arc::get_mut(&mut app).unwrap().config.origin = Some("https://nimlo.example.ts.net".into());
        connect_test_devices(&app, &token);
        let expected = json!({"status":"ready","url":"https://nimlo.example.ts.net","error":null,"available":true,"managed":false});
        assert_eq!(
            app.bootstrap(Some("desktop")).unwrap()["internet"],
            expected
        );
        assert!(app.accepts_headers(&own_headers(), true));
        assert_eq!(
            dispatch(
                app.clone(),
                "phone123".into(),
                2,
                Command::InternetStart { generation: 1 }
            )
            .await
            .unwrap()["internet"],
            expected
        );
        assert_eq!(
            dispatch(
                app.clone(),
                "phone123".into(),
                2,
                Command::InternetStop { generation: 1 }
            )
            .await
            .unwrap_err()
            .code,
            "internet_managed"
        );
        assert_eq!(app.remote.snapshot().status, remote::RemoteStatus::Off);
    }

    #[tokio::test]
    async fn internet_commands_fence_unpaired_replaced_and_stale_devices() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        for stop in [false, true] {
            for (client, connection, generation) in
                [("unknown", 3, 1), ("phone123", 1, 1), ("phone123", 2, 2)]
            {
                let command = if stop {
                    Command::InternetStop { generation }
                } else {
                    Command::InternetStart { generation }
                };
                assert_eq!(
                    dispatch(app.clone(), client.into(), connection, command)
                        .await
                        .unwrap_err()
                        .code,
                    "stale_generation"
                );
            }
        }
        assert_eq!(app.remote.snapshot().status, remote::RemoteStatus::Off);
        assert_eq!(
            dispatch(
                app.clone(),
                "phone123".into(),
                2,
                Command::InternetStop { generation: 1 }
            )
            .await
            .unwrap()["internet"]["status"],
            "off"
        );
        app.session.lock().unwrap().tokens.remove(&token);
        assert_eq!(
            dispatch(
                app.clone(),
                "phone123".into(),
                2,
                Command::InternetStart { generation: 1 }
            )
            .await
            .unwrap_err()
            .code,
            "auth"
        );
    }
    #[test]
    fn shared_access_fences_project_generations_connection_epochs_and_pair_tokens() {
        let (_root, _state, app, token) = test_app();
        connect_test_devices(&app, &token);
        execute(&app, "phone123", 2, Command::ClaimControl).unwrap();
        execute(&app, "desktop", 1, Command::ClaimControl).unwrap();
        execute(
            &app,
            "desktop",
            1,
            Command::HandoffControl {
                target_client_id: "phone123".into(),
                generation: 1,
            },
        )
        .unwrap();
        let create = || Command::CreateFile {
            path: "forbidden.txt".into(),
            content: "stale".into(),
            generation: 1,
        };
        {
            let session = app.session.lock().unwrap();
            assert_eq!(session.generation, 1);
            assert!(session.authorize("desktop", 1, 1).is_ok());
            assert!(session.authorize("phone123", 2, 1).is_ok());
        }
        assert_eq!(
            execute(&app, "unknown", 2, create()).unwrap_err().code,
            "stale_generation"
        );
        assert_eq!(
            execute(&app, "phone123", 1, create()).unwrap_err().code,
            "stale_generation"
        );
        app.session
            .lock()
            .unwrap()
            .clients
            .get_mut("phone123")
            .unwrap()
            .connection = 3;
        assert_eq!(
            execute(&app, "phone123", 2, create()).unwrap_err().code,
            "stale_generation"
        );
        {
            let mut session = app.session.lock().unwrap();
            assert!(session.authorize("phone123", 3, 1).is_ok());
            session.clients.get_mut("phone123").unwrap().connected = false;
        }
        assert_eq!(
            execute(&app, "phone123", 3, create()).unwrap_err().code,
            "stale_generation"
        );
        {
            let mut session = app.session.lock().unwrap();
            session.clients.get_mut("phone123").unwrap().connected = true;
            session.tokens.remove(&token);
        }
        assert_eq!(
            execute(&app, "phone123", 3, create()).unwrap_err().code,
            "auth"
        );
        {
            let mut session = app.session.lock().unwrap();
            session
                .tokens
                .insert(token, auth::TokenRecord::host(Instant::now()));
            session.generation = 2;
        }
        assert_eq!(
            execute(&app, "desktop", 1, create()).unwrap_err().code,
            "stale_generation"
        );
        assert_eq!(
            execute(
                &app,
                "phone123",
                3,
                Command::OpenFile {
                    path: "test.txt".into(),
                    generation: Some(1)
                }
            )
            .unwrap_err()
            .code,
            "stale_generation"
        );
        assert!(
            !app.session
                .lock()
                .unwrap()
                .workspace
                .root
                .join("forbidden.txt")
                .exists()
        );
    }
}
