//! One on-demand Quick Tunnel. No process, polling task, or output history is
//! retained while off. Provider output is consumed with fixed-size buffers and
//! never forwarded to browsers or written to the host's logs.

use serde::Serialize;
use std::{
    ffi::OsStr,
    fs::{DirBuilder, OpenOptions},
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::{Mutex as AsyncMutex, oneshot, watch},
    task::JoinHandle,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(35);
const READ_BYTES: usize = 4096;
const MAX_LINE_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteStatus {
    Off,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSnapshot {
    pub status: RemoteStatus,
    /// An origin only; pairing credentials are added by the host separately.
    pub url: Option<String>,
    pub error: Option<String>,
    pub available: bool,
}

struct State {
    snapshot: RemoteSnapshot,
    generation: u64,
}

struct Process {
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

pub struct RemoteManager {
    state: Arc<Mutex<State>>,
    // The lock spans spawn and reap, so concurrent starts cannot create two
    // tunnels. Monitor updates never acquire this lock.
    process: AsyncMutex<Option<Process>>,
    changes: watch::Sender<u64>,
    upstream: String,
    startup_timeout: Duration,
    #[cfg(test)]
    test_binary: Option<PathBuf>,
}

impl RemoteManager {
    pub fn new(listen: SocketAddr) -> Self {
        let target_ip = match listen.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            ip => ip,
        };
        let (changes, _) = watch::channel(0);
        Self {
            state: Arc::new(Mutex::new(State {
                snapshot: RemoteSnapshot {
                    status: RemoteStatus::Off,
                    url: None,
                    error: None,
                    available: resolve_binary().is_some(),
                },
                generation: 0,
            })),
            process: AsyncMutex::new(None),
            changes,
            upstream: format!("http://{}", SocketAddr::new(target_ip, listen.port())),
            startup_timeout: STARTUP_TIMEOUT,
            #[cfg(test)]
            test_binary: None,
        }
    }

    pub fn snapshot(&self) -> RemoteSnapshot {
        self.state.lock().unwrap().snapshot.clone()
    }

    pub fn origin(&self) -> Option<String> {
        let state = self.state.lock().unwrap();
        (state.snapshot.status == RemoteStatus::Ready)
            .then(|| state.snapshot.url.clone())
            .flatten()
    }

    /// Latest revision only: slow subscribers never queue process output.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    #[cfg(test)]
    async fn start(&self) -> Result<RemoteSnapshot, String> {
        self.start_if(|| Ok(())).await
    }

    /// Authorization is rechecked after taking the operation lock. Starting
    /// returns immediately; the watch receiver announces ready/error later.
    pub async fn start_if(
        &self,
        authorize: impl FnOnce() -> Result<(), String>,
    ) -> Result<RemoteSnapshot, String> {
        let mut slot = self.process.lock().await;
        // A canceled stop still owns its slot until its child has been reaped.
        if let Some(process) = slot.as_mut() {
            if process.stop.is_some()
                && !process.task.is_finished()
                && matches!(
                    self.snapshot().status,
                    RemoteStatus::Starting | RemoteStatus::Ready
                )
            {
                authorize()?;
                return Ok(self.snapshot());
            }
            if let Some(stop) = process.stop.take() {
                let _ = stop.send(());
            }
            let _ = (&mut process.task).await;
        }
        *slot = None;
        authorize()?;

        let binary = self.binary();
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.generation = state.generation.wrapping_add(1);
            state.snapshot = RemoteSnapshot {
                status: RemoteStatus::Starting,
                url: None,
                error: None,
                available: binary.is_some(),
            };
            state.generation
        };
        notify(&self.changes);
        let Some(binary) = binary else {
            return self.start_error(
                generation,
                "Install cloudflared to create an internet link.",
            );
        };
        let isolated = match IsolatedConfig::new() {
            Ok(config) => config,
            Err(_) => {
                return self.start_error(
                    generation,
                    "Could not create an isolated tunnel configuration.",
                );
            }
        };
        let mut command = tunnel_command(&binary, &isolated, &self.upstream);
        let child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                return self.start_error(
                    generation,
                    "Could not start cloudflared. Check its installation.",
                );
            }
        };
        let (stop, stopped) = oneshot::channel();
        // No await between spawning and recording the process: cancellation
        // cannot leave an untracked child or skip the kill/reap monitor.
        let task = tokio::spawn(monitor(
            child,
            isolated,
            stopped,
            self.state.clone(),
            self.changes.clone(),
            generation,
            self.startup_timeout,
        ));
        *slot = Some(Process {
            stop: Some(stop),
            task,
        });
        Ok(self.snapshot())
    }

    pub async fn stop_if(
        &self,
        authorize: impl FnOnce() -> Result<(), String>,
    ) -> Result<RemoteSnapshot, String> {
        let mut slot = self.process.lock().await;
        authorize()?;
        {
            let mut state = self.state.lock().unwrap();
            // Revoke the public authority before waiting for process cleanup.
            state.generation = state.generation.wrapping_add(1);
            state.snapshot.status = RemoteStatus::Off;
            state.snapshot.url = None;
            state.snapshot.error = None;
        }
        notify(&self.changes);
        if let Some(process) = slot.as_mut() {
            if let Some(stop) = process.stop.take() {
                let _ = stop.send(());
            }
            let _ = (&mut process.task).await;
        }
        *slot = None;
        Ok(self.snapshot())
    }

    pub async fn stop(&self) -> RemoteSnapshot {
        self.stop_if(|| Ok(())).await.expect("unconditional stop")
    }

    pub async fn shutdown(&self) {
        self.stop().await;
    }

    fn binary(&self) -> Option<PathBuf> {
        #[cfg(test)]
        if let Some(binary) = &self.test_binary {
            return Some(binary.clone());
        }
        resolve_binary()
    }

    fn start_error(&self, generation: u64, message: &str) -> Result<RemoteSnapshot, String> {
        set_error(&self.state, &self.changes, generation, message);
        Err(message.to_owned())
    }
}

fn tunnel_command(binary: &Path, config: &IsolatedConfig, upstream: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .arg("tunnel")
        .arg("--config")
        .arg(&config.path)
        .arg("--no-autoupdate")
        .arg("--url")
        .arg(upstream)
        .args(["--metrics", "127.0.0.1:0", "--grace-period", "1s"])
        .args(["--proxy-keepalive-connections", "4"])
        .args(["--loglevel", "info", "--transport-loglevel", "warn"])
        .arg("--management-diagnostics=false")
        .current_dir(&config.directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Explicit empty config prevents discovery of the user's named tunnel.
    // Remove all cloudflared environment flags, including token, credentials,
    // ingress/Host overrides, log paths and alternate provisioning endpoints.
    for (key, _) in std::env::vars_os() {
        if is_tunnel_env(&key) {
            command.env_remove(key);
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    command
}

fn is_tunnel_env(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    key.starts_with("TUNNEL_")
        || key.starts_with("CLOUDFLARED_")
        || matches!(
            key.as_ref(),
            "NO_AUTOUPDATE" | "NO_TLS_VERIFY" | "QUICK_SERVICE"
        )
}

async fn monitor(
    mut child: Child,
    _config: IsolatedConfig,
    mut stop: oneshot::Receiver<()>,
    state: Arc<Mutex<State>>,
    changes: watch::Sender<u64>,
    generation: u64,
    startup_timeout: Duration,
) {
    let pid = child.id();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut out_buffer = [0; READ_BYTES];
    let mut err_buffer = [0; READ_BYTES];
    let mut out_lines = BoundedLines::default();
    let mut err_lines = BoundedLines::default();
    let mut out_open = true;
    let mut err_open = true;
    let mut startup = Startup::default();
    let mut ready = false;
    let deadline = tokio::time::sleep(startup_timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = child.wait() => {
                set_error(&state, &changes, generation, if ready {
                    "The internet link stopped. Start it again to create a new link."
                } else {
                    "cloudflared exited before the link was ready. Check internet access and retry."
                });
                // Kill any descendants left holding output pipes by a wrapper.
                kill_group(pid);
                return;
            }
            _ = &mut deadline, if !ready => {
                set_error(&state, &changes, generation,
                    "The internet link did not connect within 35 seconds. Check internet access and retry.");
                break;
            }
            result = stdout.read(&mut out_buffer), if out_open => {
                match result {
                    Ok(0) => { out_open = false; out_lines.finish(&mut startup); }
                    Ok(count) => out_lines.push(&out_buffer[..count], &mut startup),
                    Err(_) => {
                        set_error(&state, &changes, generation, "Could not read cloudflared status.");
                        break;
                    }
                }
            }
            result = stderr.read(&mut err_buffer), if err_open => {
                match result {
                    Ok(0) => { err_open = false; err_lines.finish(&mut startup); }
                    Ok(count) => err_lines.push(&err_buffer[..count], &mut startup),
                    Err(_) => {
                        set_error(&state, &changes, generation, "Could not read cloudflared status.");
                        break;
                    }
                }
            }
        }
        if !ready
            && startup.registered
            && let Some(url) = &startup.url
        {
            let mut state = state.lock().unwrap();
            if state.generation == generation && state.snapshot.status == RemoteStatus::Starting {
                state.snapshot.status = RemoteStatus::Ready;
                state.snapshot.url = Some(url.clone());
                ready = true;
                notify(&changes);
            }
        }
    }
    kill_group(pid);
    let _ = child.start_kill();
    let _ = child.wait().await;
}

fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // The child has its own process group, never the host/user's group.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

fn set_error(state: &Mutex<State>, changes: &watch::Sender<u64>, generation: u64, error: &str) {
    let mut state = state.lock().unwrap();
    if state.generation != generation {
        return;
    }
    state.snapshot.status = RemoteStatus::Error;
    state.snapshot.url = None;
    state.snapshot.error = Some(error.to_owned());
    notify(changes);
}

fn notify(changes: &watch::Sender<u64>) {
    changes.send_modify(|version| *version = version.wrapping_add(1));
}

#[derive(Default)]
struct Startup {
    url: Option<String>,
    registered: bool,
}

impl Startup {
    fn line(&mut self, bytes: &[u8]) {
        let Ok(line) = std::str::from_utf8(bytes) else {
            return;
        };
        if self.url.is_none() {
            self.url = quick_tunnel_url(line);
        }
        // This is emitted after the edge accepts the tunnel registration.
        self.registered |= line.contains("Registered tunnel connection");
    }
}

#[derive(Default)]
struct BoundedLines {
    bytes: Vec<u8>,
    overflow: bool,
}

impl BoundedLines {
    fn push(&mut self, bytes: &[u8], startup: &mut Startup) {
        for &byte in bytes {
            if byte == b'\n' || byte == b'\r' {
                self.finish(startup);
            } else if self.bytes.len() < MAX_LINE_BYTES {
                self.bytes.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }

    fn finish(&mut self, startup: &mut Startup) {
        if !self.overflow {
            startup.line(&self.bytes);
        }
        self.bytes.clear();
        self.overflow = false;
    }
}

fn quick_tunnel_url(line: &str) -> Option<String> {
    // Split only at log/table delimiters. A suffix such as /path, :443,
    // @evil.test, .evil.test or ?token must invalidate the entire token.
    line.split(|ch: char| ch.is_ascii_whitespace() || matches!(ch, '|' | '"' | '\'' | '<' | '>'))
        .find(|token| {
            let Some(label) = token
                .strip_prefix("https://")
                .and_then(|host| host.strip_suffix(".trycloudflare.com"))
            else {
                return false;
            };
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == b'-')
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
        })
        .map(str::to_owned)
}

struct IsolatedConfig {
    directory: PathBuf,
    path: PathBuf,
}

impl IsolatedConfig {
    fn new() -> std::io::Result<Self> {
        let directory = std::env::temp_dir().join(format!(
            "nimlo-tunnel-{}-{:016x}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory)?;
        let config = Self {
            path: directory.join("config.yml"),
            directory,
        };
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&config.path)?.write_all(b"{}\n")?;
        Ok(config)
    }
}

impl Drop for IsolatedConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn resolve_binary() -> Option<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("cloudflared"))
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".local/bin/cloudflared"));
    }
    paths.into_iter().find_map(|path| {
        let metadata = path.metadata().ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        path.canonicalize().ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_complete_quick_tunnel_origins() {
        assert_eq!(
            quick_tunnel_url("INF | https://plain-12.trycloudflare.com |"),
            Some("https://plain-12.trycloudflare.com".into())
        );
        for invalid in [
            "http://plain.trycloudflare.com",
            "https://plain.trycloudflare.com.evil.test",
            "https://plain.trycloudflare.com/path",
            "https://plain.trycloudflare.com?token=secret",
            "https://plain.trycloudflare.com:443",
            "https://plain.trycloudflare.com@evil.test",
            "https://PLAIN.trycloudflare.com",
            "https://sub.plain.trycloudflare.com",
            "https://-plain.trycloudflare.com",
            "https://plain-.trycloudflare.com",
            "https://.trycloudflare.com",
            "prefixhttps://plain.trycloudflare.com",
        ] {
            assert_eq!(quick_tunnel_url(invalid), None, "{invalid}");
        }
        assert!(
            quick_tunnel_url(&format!("https://{}.trycloudflare.com", "a".repeat(64))).is_none()
        );
    }

    #[test]
    fn oversized_and_unterminated_logs_never_grow_or_supply_a_url() {
        let mut lines = BoundedLines::default();
        let mut startup = Startup::default();
        lines.push(b"https://discard.trycloudflare.com ", &mut startup);
        for _ in 0..1024 {
            lines.push(&[b'x'; 4096], &mut startup);
        }
        assert_eq!(lines.bytes.len(), MAX_LINE_BYTES);
        assert!(lines.bytes.capacity() <= MAX_LINE_BYTES);
        lines.push(b"\nRegistered tunnel connection\n", &mut startup);
        assert!(startup.registered);
        assert!(startup.url.is_none());
        for bytes in b"| https://accepted.trycloudflare.com |\n".chunks(3) {
            lines.push(bytes, &mut startup);
        }
        assert_eq!(
            startup.url.as_deref(),
            Some("https://accepted.trycloudflare.com")
        );
    }

    #[test]
    fn upstream_matches_the_bound_address() {
        for (listen, upstream) in [
            ("0.0.0.0:7331", "http://127.0.0.1:7331"),
            ("[::]:7331", "http://[::1]:7331"),
            ("192.168.1.8:7331", "http://192.168.1.8:7331"),
        ] {
            assert_eq!(
                RemoteManager::new(listen.parse().unwrap()).upstream,
                upstream
            );
        }
    }

    #[test]
    fn command_isolated_from_tunnel_environment_and_configuration() {
        let config = IsolatedConfig::new().unwrap();
        let path = config.path.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        let command = tunnel_command(
            Path::new("/test/cloudflared"),
            &config,
            "http://127.0.0.1:7331",
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|v| v.to_string_lossy())
            .collect();
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--metrics", "127.0.0.1:0"])
        );
        assert!(args.contains(&"--no-autoupdate".into()));
        assert!(
            !args
                .iter()
                .any(|arg| arg.contains("token") || arg.contains("http-host-header"))
        );
        for key in [
            "TUNNEL_TOKEN",
            "TUNNEL_CRED_FILE",
            "TUNNEL_NAME",
            "TUNNEL_HTTP_HOST_HEADER",
            "TUNNEL_LOGFILE",
            "CLOUDFLARED_CONFIG",
            "QUICK_SERVICE",
            "NO_TLS_VERIFY",
        ] {
            assert!(is_tunnel_env(OsStr::new(key)), "{key}");
        }
        assert!(!is_tunnel_env(OsStr::new("PATH")));
        drop(config);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    fn fake(script: &str, timeout: Duration) -> (tempfile::TempDir, RemoteManager) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cloudflared");
        std::fs::write(
            &path,
            format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> \"${{0%/*}}/pids\"\n{script}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut manager = RemoteManager::new("127.0.0.1:7331".parse().unwrap());
        manager.test_binary = Some(path);
        manager.startup_timeout = timeout;
        (directory, manager)
    }

    #[cfg(unix)]
    async fn wait_status(manager: &RemoteManager, status: RemoteStatus) -> RemoteSnapshot {
        let mut changes = manager.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = manager.snapshot();
                if snapshot.status == status {
                    return snapshot;
                }
                changes.changed().await.unwrap();
            }
        })
        .await
        .unwrap()
    }

    #[cfg(unix)]
    fn pids(directory: &Path) -> Vec<i32> {
        std::fs::read_to_string(directory.join("pids"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.parse().unwrap())
            .collect()
    }

    #[cfg(unix)]
    fn assert_reaped(pid: i32) {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "child {pid} still alive");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lazy_singleton_starts_registers_stops_restarts_and_reaps() {
        let (directory, manager) = fake(
            "printf '%s\\n' 'https://fixture.trycloudflare.com'\n/bin/sleep 0.05\nprintf '%s\\n' 'Registered tunnel connection' >&2\nexec /bin/sleep 60",
            STARTUP_TIMEOUT,
        );
        assert_eq!(manager.snapshot().status, RemoteStatus::Off);
        assert!(pids(directory.path()).is_empty());
        let initial = manager.start().await.unwrap();
        assert_eq!(initial.status, RemoteStatus::Starting);
        assert!(initial.url.is_none());
        let (a, b) = tokio::join!(manager.start(), manager.start());
        a.unwrap();
        b.unwrap();
        let ready = wait_status(&manager, RemoteStatus::Ready).await;
        assert_eq!(
            ready.url.as_deref(),
            Some("https://fixture.trycloudflare.com")
        );
        let first_pids = pids(directory.path());
        assert_eq!(first_pids.len(), 1);
        let stopped = manager.stop().await;
        assert_eq!(stopped.status, RemoteStatus::Off);
        assert!(stopped.url.is_none());
        assert_reaped(first_pids[0]);
        manager.start().await.unwrap();
        wait_status(&manager, RemoteStatus::Ready).await;
        manager.shutdown().await;
        let all_pids = pids(directory.path());
        assert_eq!(all_pids.len(), 2);
        for pid in all_pids {
            assert_reaped(pid);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn authorization_failure_never_starts_or_stops_a_tunnel() {
        let (directory, manager) = fake(
            "printf '%s\\n' 'https://fixture.trycloudflare.com' 'Registered tunnel connection'\nexec /bin/sleep 60",
            STARTUP_TIMEOUT,
        );
        assert!(
            manager
                .start_if(|| Err("Unauthorized".into()))
                .await
                .is_err()
        );
        assert!(pids(directory.path()).is_empty());
        assert_eq!(manager.snapshot().status, RemoteStatus::Off);
        manager.start().await.unwrap();
        wait_status(&manager, RemoteStatus::Ready).await;
        assert!(
            manager
                .stop_if(|| Err("Unauthorized".into()))
                .await
                .is_err()
        );
        assert_eq!(manager.snapshot().status, RemoteStatus::Ready);
        manager.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn url_without_registration_times_out_and_reaps() {
        let (directory, manager) = fake(
            "printf '%s\\n' 'https://fixture.trycloudflare.com'\nexec /bin/sleep 60",
            // Parallel process tests can delay the shell's first instruction.
            // Allow it to write its PID before exercising the deadline.
            Duration::from_secs(3),
        );
        manager.start().await.unwrap();
        let failed = wait_status(&manager, RemoteStatus::Error).await;
        assert!(failed.url.is_none());
        assert!(failed.error.unwrap().contains("did not connect"));
        manager.shutdown().await;
        let children = pids(directory.path());
        assert_eq!(children.len(), 1);
        assert_reaped(children[0]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unexpected_exit_clears_authority_and_does_not_echo_output() {
        let (directory, manager) = fake(
            "printf '%s\\n' 'https://fixture.trycloudflare.com' 'Registered tunnel connection'\n/bin/sleep 0.1\nprintf '%s\\n' 'secret=https://private.invalid/token' >&2\nexit 4",
            STARTUP_TIMEOUT,
        );
        manager.start().await.unwrap();
        wait_status(&manager, RemoteStatus::Ready).await;
        let error = wait_status(&manager, RemoteStatus::Error).await;
        assert!(error.url.is_none());
        assert!(!error.error.unwrap().contains("secret"));
        manager.shutdown().await;
        assert_reaped(pids(directory.path())[0]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_failure_is_visible_without_raw_command_output() {
        let (_directory, mut manager) = fake("exit 0", STARTUP_TIMEOUT);
        manager.test_binary = Some(PathBuf::from("/nonexistent/nimlo-test-cloudflared"));
        assert!(
            manager
                .start()
                .await
                .unwrap_err()
                .contains("Could not start")
        );
        assert_eq!(manager.snapshot().status, RemoteStatus::Error);
        assert!(manager.snapshot().url.is_none());
        assert!(manager.process.lock().await.is_none());
    }
}
