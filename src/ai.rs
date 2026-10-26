//! On-demand adapters to the unmodified, locally authenticated provider CLIs.
//! No credential files are read by the editor. Browser lifetime is independent
//! of these host-owned tasks; only an explicit cancellation stops a running turn.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
};

const MAX_TRANSCRIPT: usize = 60 * 1024;
const MAX_MESSAGES: usize = 128;
const MAX_LINE: usize = 256 * 1024;
const MAX_PROMPT: usize = 32 * 1024;
const MAX_APPROVALS: usize = 8;
const MAX_DETAIL: usize = 2048;
const MAX_SETTINGS: usize = 4096;
const EDITOR_INSTRUCTIONS: &str = "You are assisting in a shared code editor. For a requested change to the selected file, prefer returning the COMPLETE updated file in one fenced code block so the user can review and apply it through the editor. Do not claim changes were saved unless a tool actually saved them. Unsaved editor text can differ from disk.";

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Ask,
    FullAccess,
}

impl PermissionMode {
    fn instructions(self) -> String {
        format!(
            "{EDITOR_INSTRUCTIONS} {}",
            match self {
                Self::Ask =>
                    "Ask for approval before changing files or running commands that mutate the workspace.",
                Self::FullAccess =>
                    "The user has explicitly enabled full access for this AI turn. You may change files and run commands without asking for permission. Explain meaningful changes and their results.",
            }
        )
    }

    fn approval_policy(self) -> &'static str {
        match self {
            Self::Ask => "on-request",
            Self::FullAccess => "never",
        }
    }

    fn sandbox(self) -> &'static str {
        match self {
            Self::Ask => "read-only",
            Self::FullAccess => "danger-full-access",
        }
    }

    fn sandbox_policy(self) -> Value {
        match self {
            Self::Ask => json!({"type":"readOnly","networkAccess":false}),
            Self::FullAccess => json!({"type":"dangerFullAccess"}),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub auth: String,
    pub detail: String,
    pub binary_path: Option<String>,
    pub login_command: String,
    pub help_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSettings {
    pub default_provider: String,
    pub permission_mode: PermissionMode,
    pub codex: CodexSettings,
    pub claude: ClaudeSettings,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            default_provider: "codex".into(),
            permission_mode: PermissionMode::Ask,
            codex: CodexSettings::default(),
            claude: ClaudeSettings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexSettings {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeSettings {
    pub model: Option<String>,
}

impl AiSettings {
    fn validated(mut self) -> Result<Self, String> {
        if !matches!(self.default_provider.as_str(), "codex" | "claude") {
            return Err("Choose Codex or Claude Code as the default provider.".into());
        }
        self.codex.model = model_identifier(self.codex.model)?;
        self.claude.model = model_identifier(self.claude.model)?;
        self.codex.reasoning_effort = self
            .codex
            .reasoning_effort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| -> Result<String, String> {
                if value.len() > 32
                    || !value.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'-' || byte == b'_')
                {
                    Err("Reasoning effort must be a model-supported identifier of at most 32 bytes.".into())
                } else {
                    Ok(value.to_owned())
                }
            })
            .transpose()?;
        Ok(self)
    }
}

fn model_identifier(model: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@+-[]".contains(&byte))
    {
        return Err("Model must be a provider model identifier of at most 128 bytes, without spaces or command flags.".into());
    }
    Ok(Some(value.to_owned()))
}

#[derive(Clone, Debug, Serialize)]
pub struct AiMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiApproval {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub choices: Vec<String>,
    pub choice_labels: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiSnapshot {
    pub provider: Option<String>,
    pub status: String,
    pub messages: Vec<AiMessage>,
    pub approvals: Vec<AiApproval>,
    pub error: Option<String>,
    pub truncated: bool,
    pub session_id: Option<String>,
}

impl Default for AiSnapshot {
    fn default() -> Self {
        Self {
            provider: None,
            status: "idle".into(),
            messages: vec![],
            approvals: vec![],
            error: None,
            truncated: false,
            session_id: None,
        }
    }
}

struct State {
    workspace: PathBuf,
    snapshot: AiSnapshot,
    providers: Vec<ProviderInfo>,
    binaries: HashMap<String, PathBuf>,
    settings: AiSettings,
    settings_error: Option<String>,
    control: Option<mpsc::Sender<Control>>,
    pending: HashMap<String, Pending>,
    epoch: u64,
    // Authoritative final item replaces deltas without doubling the transcript.
    message_ids: Vec<Option<String>>,
    item_details: HashMap<String, String>,
}

#[derive(Clone)]
enum Pending {
    Codex {
        id: Value,
        method: String,
        params: Value,
    },
    Claude {
        id: String,
        input: Value,
    },
}
enum Control {
    Cancel,
    Reply(Value),
}

#[derive(Clone)]
pub struct AiManager {
    state: Arc<Mutex<State>>,
    notify: Arc<dyn Fn() + Send + Sync>,
    settings_path: Option<PathBuf>,
    rediscover_binaries: bool,
    auth_gate: Arc<tokio::sync::Mutex<()>>,
}

struct Job {
    epoch: u64,
    provider: String,
    binary: PathBuf,
    prompt: String,
    resume: Option<String>,
    workspace: PathBuf,
    settings: AiSettings,
}

impl AiManager {
    pub fn new(workspace: PathBuf, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        let path = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| crate::branding::state_root(&home).join("ai-settings.json"));
        Self::installed(workspace, notify, path)
    }

    pub fn new_with_settings_path(
        workspace: PathBuf,
        notify: Arc<dyn Fn() + Send + Sync>,
        settings_path: PathBuf,
    ) -> Self {
        Self::installed(workspace, notify, Some(settings_path))
    }

    fn installed(
        workspace: PathBuf,
        notify: Arc<dyn Fn() + Send + Sync>,
        settings_path: Option<PathBuf>,
    ) -> Self {
        let binaries: HashMap<_, _> = ["codex", "claude"]
            .into_iter()
            .filter_map(|id| resolve_binary(id).map(|path| (id.into(), path)))
            .collect();
        let mut manager = Self::with_binaries(workspace, notify, binaries);
        manager.rediscover_binaries = true;
        manager.settings_path = settings_path;
        if let Some(path) = &manager.settings_path {
            match load_settings(path) {
                Ok(Some(settings)) => manager.state.lock().unwrap().settings = settings,
                Ok(None) => {}
                Err(error) => manager.state.lock().unwrap().settings_error = Some(error),
            }
        }
        manager
    }

    fn with_binaries(
        workspace: PathBuf,
        notify: Arc<dyn Fn() + Send + Sync>,
        binaries: HashMap<String, PathBuf>,
    ) -> Self {
        let providers = ["codex", "claude"]
            .into_iter()
            .map(|id| ProviderInfo {
                id: id.into(),
                name: if id == "codex" {
                    "Codex"
                } else {
                    "Claude Code"
                }
                .into(),
                available: binaries.contains_key(id),
                auth: "unknown".into(),
                detail: if binaries.contains_key(id) {
                    "Uses the installed CLI sign-in. Account status has not been checked."
                } else {
                    "CLI was not found on PATH or in ~/.local/bin."
                }
                .into(),
                binary_path: binaries
                    .get(id)
                    .map(|path| path.to_string_lossy().into_owned()),
                login_command: if id == "codex" {
                    "codex login"
                } else {
                    "claude auth login"
                }
                .into(),
                help_url: if id == "codex" {
                    "https://learn.chatgpt.com/docs/auth"
                } else {
                    "https://code.claude.com/docs/en/authentication"
                }
                .into(),
            })
            .collect();
        let settings = AiSettings {
            default_provider: if !binaries.contains_key("codex") && binaries.contains_key("claude")
            {
                "claude"
            } else {
                "codex"
            }
            .into(),
            ..AiSettings::default()
        };
        Self {
            state: Arc::new(Mutex::new(State {
                workspace,
                snapshot: AiSnapshot::default(),
                providers,
                binaries,
                settings,
                settings_error: None,
                control: None,
                pending: HashMap::new(),
                epoch: 0,
                message_ids: vec![],
                item_details: HashMap::new(),
            })),
            notify,
            settings_path: None,
            rediscover_binaries: false,
            auth_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn providers(&self) -> Vec<ProviderInfo> {
        self.state.lock().unwrap().providers.clone()
    }
    pub fn snapshot(&self) -> AiSnapshot {
        self.state.lock().unwrap().snapshot.clone()
    }

    pub fn settings(&self) -> AiSettings {
        self.state.lock().unwrap().settings.clone()
    }
    pub fn settings_error(&self) -> Option<String> {
        self.state.lock().unwrap().settings_error.clone()
    }

    /// Reuse installed providers and settings without starting a CLI or sharing
    /// a conversation, approval queue, or process with another project.
    pub fn for_project(&self, workspace: PathBuf, notify: Arc<dyn Fn() + Send + Sync>) -> Self {
        let state = self.state.lock().unwrap();
        let mut manager = Self::with_binaries(workspace, notify, state.binaries.clone());
        manager.rediscover_binaries = self.rediscover_binaries;
        manager.settings_path = self.settings_path.clone();
        {
            let mut target = manager.state.lock().unwrap();
            target.providers = state.providers.clone();
            target.settings = state.settings.clone();
            target.settings_error = state.settings_error.clone();
        }
        manager
    }

    pub fn apply_shared_settings(&self, settings: &AiSettings) {
        let mut state = self.state.lock().unwrap();
        if *settings != state.settings && state.control.is_none() {
            reset_conversation(&mut state);
        }
        state.settings = settings.clone();
    }

    pub fn inherit_host_configuration(&self, host: &Self) {
        if Arc::ptr_eq(&self.state, &host.state) {
            return;
        }
        let source = host.state.lock().unwrap();
        let mut target = self.state.lock().unwrap();
        if target.settings != source.settings && target.control.is_none() {
            reset_conversation(&mut target);
        }
        target.settings = source.settings.clone();
        target.providers = source.providers.clone();
        target.binaries = source.binaries.clone();
        target.settings_error = source.settings_error.clone();
    }
    pub fn is_busy(&self) -> bool {
        self.state.lock().unwrap().control.is_some()
    }

    /// Settings contain only provider/model preferences, never credentials.
    /// Persist before acknowledging or changing the canonical in-memory values.
    pub fn configure(&self, settings: AiSettings) -> Result<AiSettings, String> {
        let settings = settings.validated()?;
        {
            let mut state = self.state.lock().unwrap();
            if state.control.is_some() {
                return Err(
                    "Wait for the active AI job to finish before changing AI settings.".into(),
                );
            }
            let path = self
                .settings_path
                .as_ref()
                .ok_or("AI settings persistence is unavailable on this host.")?;
            save_settings(path, &settings)?;
            if settings != state.settings {
                reset_conversation(&mut state);
            }
            state.settings = settings.clone();
            state.settings_error = None;
        }
        (self.notify)();
        Ok(settings)
    }

    /// Host validates and locks the target workspace before committing a switch.
    /// The same mutex fences switches and job starts; a failed switch is inert.
    pub fn switch_workspace(&self, workspace: PathBuf) -> Result<(), String> {
        let workspace = fs::canonicalize(workspace)
            .map_err(|error| format!("Cannot open the project folder: {error}"))?;
        if !workspace.is_dir() {
            return Err("Choose a project folder.".into());
        }
        {
            let mut state = self.state.lock().unwrap();
            if state.control.is_some() {
                return Err(
                    "Wait for the active AI job to finish before changing projects.".into(),
                );
            }
            if state.workspace == workspace {
                return Ok(());
            }
            state.workspace = workspace;
            reset_conversation(&mut state);
        }
        (self.notify)();
        Ok(())
    }

    /// Optional, once-at-startup status probe. It never starts an inference turn
    /// and only retains the sign-in method, excluding email and account IDs.
    pub async fn refresh_auth(&self) {
        let _ = self.refresh_auth_checked().await;
    }

    pub async fn refresh_auth_checked(&self) -> Result<(), String> {
        let _guard = self
            .auth_gate
            .try_lock()
            .map_err(|_| "Account status is already being checked.")?;
        if self.rediscover_binaries {
            let binaries: HashMap<_, _> = ["codex", "claude"]
                .into_iter()
                .filter_map(|id| resolve_binary(id).map(|path| (id.into(), path)))
                .collect();
            let mut state = self.state.lock().unwrap();
            for provider in &mut state.providers {
                let path = binaries
                    .get(&provider.id)
                    .map(|path| path.to_string_lossy().into_owned());
                if path != provider.binary_path {
                    provider.auth = "unknown".into();
                    provider.detail = "CLI changed; account status is being checked.".into();
                }
                provider.available = path.is_some();
                provider.binary_path = path;
                if !provider.available {
                    provider.auth = "unknown".into();
                    provider.detail = "CLI was not found on PATH or in ~/.local/bin. Install it on the host, then refresh status.".into();
                }
            }
            state.binaries = binaries;
        }
        let binaries = self.state.lock().unwrap().binaries.clone();
        for id in ["codex", "claude"] {
            let Some(binary) = binaries.get(id) else {
                continue;
            };
            let args: &[&str] = if id == "codex" {
                &["login", "status"]
            } else {
                &["auth", "status"]
            };
            let status = auth_probe(binary, args, id).await;
            {
                let mut state = self.state.lock().unwrap();
                if let Some(provider) = state
                    .providers
                    .iter_mut()
                    .find(|provider| provider.id == id)
                {
                    provider.auth = status.0;
                    provider.detail = status.1;
                }
            }
        }
        (self.notify)();
        Ok(())
    }

    pub fn start(
        &self,
        provider: &str,
        prompt: &str,
        file_context: Option<&str>,
    ) -> Result<AiSnapshot, String> {
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("Enter a message for the AI.".into());
        }
        if prompt.len() > MAX_PROMPT || file_context.is_some_and(|value| value.len() > 4096) {
            return Err("AI message or file context exceeds its size limit.".into());
        }
        let job_prompt = match file_context {
            Some(context) if !context.is_empty() => format!(
                "{prompt}\n\nThe user is viewing this workspace file: {context}. Read the saved workspace file when needed. Unsaved editor text may differ; changes are reconciled by the editor."
            ),
            _ => prompt.to_owned(),
        };
        let (tx, rx) = mpsc::channel(16);
        let job = {
            let mut state = self.state.lock().unwrap();
            if state.control.is_some() {
                return Err("An AI turn is already active. Wait for it or cancel it first.".into());
            }
            let binary = state.binaries.get(provider).cloned().ok_or_else(|| "Provider CLI is not installed. Install it on the host, then refresh account status.".to_string())?;
            if state.snapshot.provider.as_deref() != Some(provider) {
                state.snapshot = AiSnapshot::default();
                state.message_ids.clear();
            }
            state.epoch = state.epoch.wrapping_add(1);
            state.snapshot.provider = Some(provider.into());
            state.snapshot.status = "starting".into();
            state.snapshot.error = None;
            state.snapshot.approvals.clear();
            state.pending.clear();
            state.item_details.clear();
            push_message(&mut state, None, "user", prompt, false);
            state.control = Some(tx);
            Job {
                epoch: state.epoch,
                provider: provider.to_owned(),
                binary,
                prompt: job_prompt,
                resume: state.snapshot.session_id.clone(),
                workspace: state.workspace.clone(),
                settings: state.settings.clone(),
            }
        };
        let manager = self.clone();
        tokio::spawn(async move {
            manager.run(job, rx).await;
        });
        (self.notify)();
        Ok(self.snapshot())
    }

    pub fn cancel(&self) -> Result<AiSnapshot, String> {
        {
            let mut state = self.state.lock().unwrap();
            let tx = state
                .control
                .as_ref()
                .ok_or_else(|| "No AI turn is active.".to_string())?;
            tx.try_send(Control::Cancel)
                .map_err(|_| "AI control queue is busy; retry cancellation.".to_string())?;
            state.snapshot.status = "cancelling".into();
            state.snapshot.approvals.clear();
            state.pending.clear();
        }
        (self.notify)();
        Ok(self.snapshot())
    }

    /// The host checks controller generation before this call. Removing the
    /// pending request under the mutex makes a repeated approval non-replayable.
    pub fn approve(&self, id: &str, choice: &str) -> Result<AiSnapshot, String> {
        {
            let mut state = self.state.lock().unwrap();
            let pending = state
                .pending
                .get(id)
                .ok_or_else(|| "This approval is no longer pending.".to_string())?;
            let approval = state
                .snapshot
                .approvals
                .iter()
                .find(|approval| approval.id == id)
                .ok_or_else(|| "Approval is unavailable.".to_string())?;
            if !approval.choices.iter().any(|candidate| candidate == choice) {
                return Err("This decision is not available for the request.".into());
            }
            let response = approval_response(pending, choice)?;
            state
                .control
                .as_ref()
                .ok_or_else(|| "AI turn has ended.".to_string())?
                .try_send(Control::Reply(response))
                .map_err(|_| "AI control queue is busy; retry the decision.".to_string())?;
            state.pending.remove(id);
            state
                .snapshot
                .approvals
                .retain(|approval| approval.id != id);
            state.snapshot.status = if state.snapshot.approvals.is_empty() {
                "running"
            } else {
                "awaiting_approval"
            }
            .into();
        }
        (self.notify)();
        Ok(self.snapshot())
    }

    fn change(&self, epoch: u64, update: impl FnOnce(&mut State)) {
        {
            let mut state = self.state.lock().unwrap();
            if state.epoch != epoch {
                return;
            }
            update(&mut state);
        }
        (self.notify)();
    }

    fn finish(&self, epoch: u64, status: &str, error: Option<String>) {
        self.change(epoch, |state| {
            state.control = None;
            state.pending.clear();
            state.item_details.clear();
            state.snapshot.approvals.clear();
            state.snapshot.status = status.into();
            state.snapshot.error = error.map(|error| clip(&error, MAX_DETAIL));
        });
    }

    async fn run(&self, job: Job, mut controls: mpsc::Receiver<Control>) {
        let Job {
            epoch,
            provider,
            binary,
            prompt,
            resume,
            workspace,
            settings,
        } = job;
        let mut command = Command::new(binary);
        command
            .current_dir(&workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if provider == "codex" {
            command.args(["app-server", "--listen", "stdio://"]);
        } else {
            // Keep native authentication methods intact. Safe mode disables
            // custom hooks and project plugins, not account authentication.
            command.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--safe-mode",
                "--strict-mcp-config",
                "--setting-sources",
                "",
                "--tools",
                "Read,Glob,Grep,Edit,Write,Bash",
            ]);
            match settings.permission_mode {
                PermissionMode::Ask => {
                    command.args([
                        "--permission-mode",
                        "manual",
                        "--permission-prompt-tool",
                        "stdio",
                        "--restricted",
                    ]);
                }
                PermissionMode::FullAccess => {
                    // Restricted mode explicitly refuses bypassPermissions.
                    // Keep safe mode and empty setting sources in both modes.
                    command.args([
                        "--permission-mode",
                        "bypassPermissions",
                        "--dangerously-skip-permissions",
                    ]);
                }
            }
            command.args([
                "--append-system-prompt",
                &settings.permission_mode.instructions(),
            ]);
            if let Some(model) = &settings.claude.model {
                command.args(["--model", model]);
            }
            if let Some(session) = &resume {
                command.args(["--resume", session]);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.finish(
                    epoch,
                    "error",
                    Some(format!("Could not start {provider}: {error}")),
                );
                return;
            }
        };
        let group_guard = ProcessGroupGuard::new(&child);
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        // Drain without retaining potentially sensitive diagnostics or allowing
        // stderr backpressure to deadlock the protocol reader.
        let mut stderr = child.stderr.take().unwrap();
        let stderr_task = tokio::spawn(async move {
            let mut bytes = [0u8; 4096];
            while matches!(stderr.read(&mut bytes).await, Ok(size) if size > 0) {}
        });
        let initial = if provider == "codex" {
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"acme_code_editor","title":"Code Editor","version":"0.1.0"}}})
        } else {
            json!({"type":"control_request","request_id":"editor-init","request":{"subtype":"initialize","hooks":null}})
        };
        if let Err(error) = send(&mut stdin, &initial).await {
            stop_child(&mut child).await;
            stderr_task.abort();
            drop(group_guard);
            self.finish(epoch, "error", Some(error));
            return;
        }
        let mut protocol = Protocol {
            provider,
            workspace,
            settings,
            prompt,
            resume,
            thread: None,
            turn: None,
            initialized: false,
            finished: None,
        };
        let handshake_deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        let mut line = Vec::with_capacity(8192);
        let outcome = loop {
            tokio::select! {
                biased;
                control = controls.recv() => {
                    match control {
                        Some(Control::Cancel) | None => {
                            if let (Some(thread), Some(turn)) = (&protocol.thread, &protocol.turn) {
                                let _ = send(&mut stdin, &json!({"id":90,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}})).await;
                            } else if protocol.provider == "claude" {
                                let _ = send(&mut stdin, &json!({"type":"control_request","request_id":"editor-cancel","request":{"subtype":"interrupt"}})).await;
                            }
                            break ("cancelled", None);
                        }
                        Some(Control::Reply(response)) => if let Err(error) = send(&mut stdin, &response).await { break ("error", Some(error)); },
                    }
                }
                _ = tokio::time::sleep_until(handshake_deadline), if !protocol.initialized => {
                    break ("error", Some("Provider initialization timed out. Check CLI sign-in in the host terminal.".into()));
                }
                result = read_bounded_line(&mut stdout, &mut line, MAX_LINE) => {
                    match result {
                        Ok(false) => {
                            let exit = child.try_wait().ok().flatten().map(|status| status.to_string()).unwrap_or_else(|| "connection closed".into());
                            break ("error", Some(format!("{} ended before completing the turn ({exit}). Check its sign-in and configuration in the host terminal.", protocol.provider)));
                        }
                        Err(error) => break ("error", Some(error)),
                        Ok(true) => {
                            let frame: Value = match serde_json::from_slice(&line) {
                                Ok(frame) => frame,
                                Err(_) => break ("error", Some("Provider emitted an invalid JSON protocol frame.".into())),
                            };
                            line.clear();
                            let result = if protocol.provider == "codex" { self.codex_frame(epoch, &mut protocol, &frame, &mut stdin).await } else { self.claude_frame(epoch, &mut protocol, &frame, &mut stdin).await };
                            if let Err(error) = result { break ("error", Some(error)); }
                            if let Some(outcome) = protocol.finished.take() { break outcome; }
                        }
                    }
                }
            }
        };
        drop(stdin);
        // End the provider process after the turn. Its saved thread/session can
        // be resumed by a fresh process on the next user message.
        stop_child(&mut child).await;
        stderr_task.abort();
        drop(group_guard);
        self.finish(epoch, outcome.0, outcome.1);
    }

    async fn codex_frame(
        &self,
        epoch: u64,
        protocol: &mut Protocol,
        frame: &Value,
        stdin: &mut ChildStdin,
    ) -> Result<(), String> {
        if frame.get("method").is_none() {
            if let Some(error) = frame.get("error") {
                return Err(error_text(error));
            }
            match frame.get("id").and_then(Value::as_u64) {
                Some(1) => {
                    send(stdin, &json!({"method":"initialized","params":{}})).await?;
                    let mode = protocol.settings.permission_mode;
                    let mut params = json!({"cwd":protocol.workspace,"approvalPolicy":mode.approval_policy(),"approvalsReviewer":"user","sandbox":mode.sandbox(),"developerInstructions":mode.instructions()});
                    if let Some(model) = &protocol.settings.codex.model {
                        params["model"] = json!(model);
                    }
                    if let Some(effort) = &protocol.settings.codex.reasoning_effort {
                        params["config"] = json!({"model_reasoning_effort":effort});
                    }
                    let method = if let Some(thread) = &protocol.resume {
                        params["threadId"] = json!(thread);
                        "thread/resume"
                    } else {
                        "thread/start"
                    };
                    send(stdin, &json!({"id":2,"method":method,"params":params})).await?;
                }
                Some(2) => {
                    let thread = frame
                        .pointer("/result/thread/id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Codex did not return a thread ID.".to_string())?
                        .to_owned();
                    protocol.thread = Some(thread.clone());
                    protocol.initialized = true;
                    self.change(epoch, |state| {
                        state.snapshot.session_id = Some(thread.clone());
                        state.snapshot.status = "running".into();
                    });
                    let mode = protocol.settings.permission_mode;
                    let mut params = json!({"threadId":thread,"input":[{"type":"text","text":protocol.prompt}],"approvalPolicy":mode.approval_policy(),"approvalsReviewer":"user","sandboxPolicy":mode.sandbox_policy()});
                    if let Some(model) = &protocol.settings.codex.model {
                        params["model"] = json!(model);
                    }
                    if let Some(effort) = &protocol.settings.codex.reasoning_effort {
                        params["effort"] = json!(effort);
                    }
                    send(
                        stdin,
                        &json!({"id":3,"method":"turn/start","params":params}),
                    )
                    .await?;
                }
                Some(3) => {
                    protocol.turn = frame
                        .pointer("/result/turn/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                _ => {}
            }
            return Ok(());
        }
        let method = frame["method"].as_str().unwrap_or("");
        let params = &frame["params"];
        if let Some(id) = frame.get("id") {
            if !(id.is_i64() || id.is_u64() || id.as_str().is_some_and(|id| id.len() <= 256)) {
                return Err("Codex sent an invalid request ID.".into());
            }
            let key = format!("{epoch}:codex:{}", id);
            match method {
                "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/permissions/requestApproval" => {
                    let kind = if method.contains("commandExecution") {
                        "command"
                    } else if method.contains("fileChange") {
                        "file"
                    } else {
                        "permissions"
                    };
                    let mut detail = self.approval_detail(kind, params);
                    let decisions = codex_decisions(params, kind)?;
                    let mut choices = decisions
                        .iter()
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    let pending = Pending::Codex {
                        id: id.clone(),
                        method: method.into(),
                        params: json!({"permissions":params["permissions"],"decisions":decisions.into_iter().collect::<serde_json::Map<String, Value>>()}),
                    };
                    if kind == "file"
                        && !params["itemId"].as_str().is_some_and(|id| {
                            self.state.lock().unwrap().item_details.contains_key(id)
                        })
                    {
                        choices.retain(|choice| !approval_grants_permission(choice));
                        detail = format!(
                            "File-change preview is unavailable. Ask for a proposed replacement instead.\n{detail}"
                        );
                    }
                    if kind == "command" && !command_preview_available(params) {
                        choices.retain(|choice| !approval_grants_permission(choice));
                        detail = format!(
                            "The provider did not supply the action to review. Cancel this request and ask it to try again.\n{detail}"
                        );
                    }
                    if kind == "permissions" && !permissions_preview_available(params) {
                        choices.retain(|choice| !approval_grants_permission(choice));
                        detail = format!(
                            "Permission scope is unavailable or unsupported. Decline this request and ask the AI to specify the access it needs.\n{detail}"
                        );
                    }
                    self.add_approval(
                        epoch,
                        key,
                        pending,
                        kind,
                        params["reason"]
                            .as_str()
                            .filter(|reason| !reason.is_empty())
                            .unwrap_or(if kind == "file" {
                                "Approve file changes"
                            } else if kind == "command" {
                                "Approve command"
                            } else {
                                "Approve additional permissions"
                            }),
                        &detail,
                        choices,
                    )?;
                }
                // Structured questions need a text-entry interface beyond the
                // current approval controls. Deny rather than hang the turn.
                "item/tool/requestUserInput" => {
                    send(stdin, &json!({"id":id,"result":{"answers":{}}})).await?;
                    self.change(epoch, |state| push_message(state,None,"system","Codex requested structured input; answer it in your next chat message.",false));
                }
                "mcpServer/elicitation/request" => {
                    send(
                        stdin,
                        &json!({"id":id,"result":{"action":"decline","content":null}}),
                    )
                    .await?;
                }
                _ => {
                    send(stdin, &json!({"id":id,"error":{"code":-32601,"message":"This editor does not support this server request."}})).await?;
                }
            }
            return Ok(());
        }
        match method {
            "turn/started" => {
                protocol.turn = params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            "item/agentMessage/delta" => {
                let id = params["itemId"].as_str().map(str::to_owned);
                self.change(epoch, |state| {
                    push_message(
                        state,
                        id,
                        "assistant",
                        params["delta"].as_str().unwrap_or(""),
                        true,
                    )
                });
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                match item["type"].as_str().unwrap_or("") {
                    "agentMessage" if method == "item/completed" => self.change(epoch, |state| {
                        push_message(
                            state,
                            item["id"].as_str().map(str::to_owned),
                            "assistant",
                            item["text"].as_str().unwrap_or(""),
                            false,
                        )
                    }),
                    "commandExecution" | "fileChange" => {
                        let detail = if item["type"] == "fileChange" {
                            file_review(item).map(|detail| {
                                if detail.len() > MAX_DETAIL {
                                    format!(
                                        "{}\n[Complete preview exceeds the review limit]",
                                        clip(&detail, MAX_DETAIL)
                                    )
                                } else {
                                    detail
                                }
                            })
                        } else {
                            None
                        };
                        self.change(epoch, |state| {
                            if let (Some(id), Some(detail)) = (item["id"].as_str(), detail) {
                                if state.item_details.len() >= 16 {
                                    state.item_details.clear();
                                }
                                state.item_details.insert(id.into(), detail);
                            }
                            if method == "item/completed" {
                                let text = if item["type"] == "fileChange" {
                                    format!(
                                        "File changes: {}",
                                        item["status"].as_str().unwrap_or("finished")
                                    )
                                } else {
                                    format!(
                                        "Command {}: {}",
                                        item["status"].as_str().unwrap_or("finished"),
                                        clip(item["command"].as_str().unwrap_or(""), 512)
                                    )
                                };
                                push_message(state, None, "tool", &text, false);
                            }
                        });
                    }
                    _ => {}
                }
            }
            "serverRequest/resolved" => {
                let key = format!("{epoch}:codex:{}", params["requestId"]);
                self.remove_approval(epoch, &key);
            }
            "error" => {
                self.change(epoch, |state| {
                    state.snapshot.error = Some(error_text(&params["error"]));
                });
            }
            "turn/completed" => {
                let turn = &params["turn"];
                protocol.finished = Some(match turn["status"].as_str() {
                    Some("completed") => ("complete", None),
                    Some("interrupted") => ("cancelled", None),
                    _ => ("error", Some(error_text(&turn["error"]))),
                });
            }
            "warning" | "configWarning" => {
                let text = params["message"]
                    .as_str()
                    .or_else(|| params["summary"].as_str())
                    .unwrap_or("Provider configuration warning.");
                self.change(epoch, |state| {
                    push_message(state, None, "system", text, false)
                });
            }
            _ => {}
        }
        Ok(())
    }

    async fn claude_frame(
        &self,
        epoch: u64,
        protocol: &mut Protocol,
        frame: &Value,
        stdin: &mut ChildStdin,
    ) -> Result<(), String> {
        if let Some(session) = frame["session_id"].as_str() {
            self.change(epoch, |state| {
                state.snapshot.session_id = Some(clip(session, 128));
            });
        }
        match frame["type"].as_str().unwrap_or("") {
            "control_response"
                if frame
                    .pointer("/response/request_id")
                    .and_then(Value::as_str)
                    == Some("editor-init") =>
            {
                if frame.pointer("/response/subtype").and_then(Value::as_str) == Some("error") {
                    return Err(error_text(&frame["response"]));
                }
                protocol.initialized = true;
                self.change(epoch, |state| {
                    state.snapshot.status = "running".into();
                });
                send(stdin, &json!({"type":"user","session_id":"","message":{"role":"user","content":protocol.prompt},"parent_tool_use_id":null})).await?;
            }
            "control_request" => {
                let id = frame["request_id"]
                    .as_str()
                    .ok_or_else(|| "Claude sent an invalid permission request.".to_string())?;
                if id.len() > 256 {
                    return Err("Claude sent an oversized request ID.".into());
                }
                let request = &frame["request"];
                if request["subtype"] == "can_use_tool" {
                    let tool = request["tool_name"].as_str().unwrap_or("tool");
                    let reviewable = claude_tool_preview_available(tool, &request["input"]);
                    let detail = readable_fields(&request["input"], &[]);
                    self.add_approval(
                        epoch,
                        format!("{epoch}:claude:{id}"),
                        Pending::Claude {
                            id: id.into(),
                            input: request["input"].clone(),
                        },
                        if tool == "Bash" { "command" } else { "file" },
                        &format!("Approve {tool}"),
                        &if reviewable { detail } else { format!("The provider did not supply a complete supported tool action to review.\n{detail}") },
                        if reviewable { vec!["accept".into(), "decline".into(), "cancel".into()] } else { vec!["decline".into(), "cancel".into()] },
                    )?;
                } else {
                    send(stdin,&json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"This editor does not support this control request."}})).await?;
                }
            }
            "control_cancel_request" => {
                if let Some(id) = frame["request_id"].as_str() {
                    self.remove_approval(epoch, &format!("{epoch}:claude:{id}"));
                }
            }
            "assistant" => {
                if let Some(blocks) = frame.pointer("/message/content").and_then(Value::as_array) {
                    let id = frame
                        .pointer("/message/id")
                        .and_then(Value::as_str)
                        .unwrap_or("reply");
                    let text = blocks
                        .iter()
                        .filter_map(|block| block["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        self.change(epoch, |state| {
                            push_message(
                                state,
                                Some(format!("claude:{id}")),
                                "assistant",
                                &text,
                                false,
                            )
                        });
                    }
                    for block in blocks.iter().filter(|block| block["type"] == "tool_use") {
                        let tool = block["name"].as_str().unwrap_or("tool");
                        self.change(epoch, |state| {
                            push_message(state, None, "tool", &format!("Using {tool}"), false)
                        });
                    }
                }
                if let Some(error) = frame["error"].as_str() {
                    self.change(epoch, |state| {
                        state.snapshot.error = Some(clip(error, MAX_DETAIL));
                    });
                }
            }
            // Partial frames are advisory; the final assistant frame is the
            // authoritative text. Using one stable stream ID avoids duplication.
            "stream_event" => {
                let event = &frame["event"];
                if event["type"] == "message_start" {
                    protocol.turn = event
                        .pointer("/message/id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                } else if event["type"] == "content_block_delta"
                    && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
                {
                    let id = format!("claude:{}", protocol.turn.as_deref().unwrap_or("reply"));
                    self.change(epoch, |state| {
                        push_message(
                            state,
                            Some(id),
                            "assistant",
                            event
                                .pointer("/delta/text")
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                            true,
                        )
                    });
                }
            }
            "result" => {
                if frame["is_error"] == true
                    || frame["subtype"]
                        .as_str()
                        .is_some_and(|subtype| subtype != "success")
                {
                    let detail = frame["result"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| {
                            frame["errors"].as_array().map(|errors| {
                                errors
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                        })
                        .unwrap_or_else(|| "Claude could not complete this turn.".into());
                    protocol.finished = Some(("error", Some(detail)));
                } else {
                    if let Some(result) = frame["result"].as_str() {
                        let snapshot = self.snapshot();
                        if !snapshot
                            .messages
                            .iter()
                            .any(|message| message.role == "assistant")
                        {
                            self.change(epoch, |state| {
                                push_message(state, None, "assistant", result, false)
                            });
                        }
                    }
                    if frame["permission_denials"]
                        .as_array()
                        .is_some_and(|denials| !denials.is_empty())
                    {
                        self.change(epoch, |state| {
                            push_message(
                                state,
                                None,
                                "system",
                                "Some tool actions were denied by Claude Code permissions.",
                                false,
                            )
                        });
                    }
                    protocol.finished = Some(("complete", None));
                }
            }
            "system" if frame["subtype"] == "permission_denied" => {
                self.change(epoch, |state| {
                    push_message(
                        state,
                        None,
                        "system",
                        "A tool action was denied by Claude Code permissions.",
                        false,
                    )
                });
            }
            _ => {}
        }
        Ok(())
    }

    fn approval_detail(&self, kind: &str, params: &Value) -> String {
        let state = self.state.lock().unwrap();
        let mut parts = vec![];
        if kind == "command"
            && let Some(command) = params["command"].as_str()
        {
            parts.push(format!(
                "{}\n{command}",
                if params["kind"] == "writeStdin" {
                    "Terminal input"
                } else {
                    "Command"
                }
            ));
        }
        if let Some(cwd) = params["cwd"].as_str() {
            parts.push(format!("Working directory\n{cwd}"));
        }
        let extras = readable_fields(
            params,
            &[
                "reason",
                "command",
                "cwd",
                "itemId",
                "threadId",
                "turnId",
                "approvalId",
                "environmentId",
                "startedAtMs",
                "durationMs",
                "aggregatedOutput",
                "commandActions",
                "availableDecisions",
                "kind",
                "proposedExecpolicyAmendment",
                "proposedNetworkPolicyAmendments",
            ],
        );
        if !extras.is_empty() {
            parts.push(extras);
        }
        // Exact decision payloads include permanent policy changes. They must
        // be visible alongside the complete action before they can be chosen.
        if let Some(decisions) = params["availableDecisions"].as_array() {
            for decision in decisions.iter().filter(|value| value.is_object()) {
                if let Some(arguments) =
                    decision.pointer("/acceptWithExecpolicyAmendment/execpolicy_amendment")
                {
                    parts.push(format!("Optional remembered command rule\nAllow commands with these leading arguments:\n{}", serde_json::to_string(arguments).unwrap_or_default()));
                } else if let Some(amendment) =
                    decision.pointer("/applyNetworkPolicyAmendment/network_policy_amendment")
                {
                    parts.push(format!(
                        "Optional remembered network rule\n{} {}",
                        amendment["action"].as_str().unwrap_or("Unknown action"),
                        amendment["host"].as_str().unwrap_or("Unknown host")
                    ));
                } else {
                    parts.push(format!(
                        "Unsupported optional rule\n{}",
                        serde_json::to_string_pretty(decision).unwrap_or_default()
                    ));
                }
            }
        }
        if kind == "file"
            && let Some(item) = params["itemId"]
                .as_str()
                .and_then(|id| state.item_details.get(id))
        {
            parts.push(item.clone());
        }
        parts.join("\n\n")
    }

    // Keep protocol identity, pending response, and review fields together.
    #[allow(clippy::too_many_arguments)]
    fn add_approval(
        &self,
        epoch: u64,
        id: String,
        pending: Pending,
        kind: &str,
        title: &str,
        detail: &str,
        choices: Vec<String>,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            if state.epoch != epoch {
                return Err("AI session has changed.".into());
            }
            if state.pending.len() >= MAX_APPROVALS {
                return Err("Provider exceeded the pending approval limit.".into());
            }
            if state.pending.contains_key(&id) {
                return Err("Provider reused a pending approval ID.".into());
            }
            // Reject approvals whose complete preview cannot fit the review
            // surface; the user can request a proposed file replacement.
            let mut disabled_reason = None;
            let (detail, choices) = if detail.len() > MAX_DETAIL {
                disabled_reason = Some(
                    "This action is too large to review safely. Ask the AI for a smaller change."
                        .into(),
                );
                (
                    format!(
                        "This action exceeds the review size limit. Ask for a proposed file replacement instead.\n{}",
                        clip(detail, MAX_DETAIL - 100)
                    ),
                    choices
                        .into_iter()
                        .filter(|choice| !approval_grants_permission(choice))
                        .collect(),
                )
            } else {
                (detail.to_owned(), choices)
            };
            let can_accept = choices
                .iter()
                .any(|choice| approval_grants_permission(choice));
            if !can_accept && disabled_reason.is_none() {
                disabled_reason = Some(if detail.starts_with("File-change preview is unavailable") {
                    "The provider did not supply the file changes to review. Ask for a proposed replacement."
                    } else if detail.starts_with("Permission scope is unavailable") {
                        "The provider did not supply a complete supported permission scope to review."
                    } else if detail.starts_with("The provider did not supply") {
                    "The provider did not supply a complete action to review."
                } else {
                    "The provider did not offer an approval decision for this request."
                }.into());
            }
            let pending = match pending {
                Pending::Codex { id, method, params } => Pending::Codex {
                    id,
                    params: json!({
                        "permissions":if can_accept && method == "item/permissions/requestApproval" {params["permissions"].clone()} else {Value::Null},
                        "decisions": params["decisions"].as_object().map(|decisions| decisions.iter().filter(|(key, _)| choices.contains(key)).map(|(key,value)| (key.clone(),value.clone())).collect::<serde_json::Map<String,Value>>()).unwrap_or_default(),
                    }),
                    method,
                },
                Pending::Claude { id, input } => Pending::Claude {
                    id,
                    input: if can_accept { input } else { Value::Null },
                },
            };
            state.snapshot.approvals.push(AiApproval {
                id: id.clone(),
                kind: kind.into(),
                title: clip(title, 256),
                detail: clip(&detail, MAX_DETAIL),
                choice_labels: choices
                    .iter()
                    .map(|choice| (choice.clone(), approval_choice_label(choice)))
                    .collect(),
                disabled_reason,
                choices,
            });
            state.pending.insert(id, pending);
            state.snapshot.status = "awaiting_approval".into();
        }
        (self.notify)();
        Ok(())
    }

    fn remove_approval(&self, epoch: u64, id: &str) {
        self.change(epoch, |state| {
            state.pending.remove(id);
            state
                .snapshot
                .approvals
                .retain(|approval| approval.id != id);
            if state.snapshot.status == "awaiting_approval" && state.snapshot.approvals.is_empty() {
                state.snapshot.status = "running".into();
            }
        });
    }
}

fn reset_conversation(state: &mut State) {
    state.epoch = state.epoch.wrapping_add(1);
    state.snapshot = AiSnapshot::default();
    state.pending.clear();
    state.message_ids.clear();
    state.item_details.clear();
}

fn load_settings(path: &Path) -> Result<Option<AiSettings>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read AI settings: {error}")),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_SETTINGS as u64
    {
        return Err("AI settings must be a regular file of at most 4 KiB.".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not open AI settings: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect AI settings: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SETTINGS as u64 {
        return Err("AI settings must be a regular file of at most 4 KiB.".into());
    }
    let mut bytes = vec![];
    file.take(MAX_SETTINGS as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read AI settings: {error}"))?;
    if bytes.len() > MAX_SETTINGS {
        return Err("AI settings exceed the 4 KiB limit.".into());
    }
    let settings: AiSettings = serde_json::from_slice(&bytes).map_err(|_| {
        "Saved AI settings are invalid. Review and save the settings again.".to_string()
    })?;
    settings.validated().map(Some)
}

fn save_settings(path: &Path, settings: &AiSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("AI settings need a private host directory.")?;
    if fs::symlink_metadata(parent).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("AI settings directory must not be a symlink.".into());
    }
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the AI settings directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not protect the AI settings directory: {error}"))?;
    }
    if fs::symlink_metadata(path)
        .is_ok_and(|metadata| !metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err("AI settings must be a regular file, not a symlink.".into());
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS {
        return Err("AI settings exceed the 4 KiB limit.".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(".ai-settings-{}-{nonce}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save AI settings: {error}"))
}

struct Protocol {
    provider: String,
    workspace: PathBuf,
    settings: AiSettings,
    prompt: String,
    resume: Option<String>,
    thread: Option<String>,
    turn: Option<String>,
    initialized: bool,
    finished: Option<(&'static str, Option<String>)>,
}

/// Tokio may drop the job future while shutting down, before it can receive a
/// queued cancellation. Child::kill_on_drop stops its direct child only; this
/// guard also stops descendants in the job's dedicated Unix process group.
struct ProcessGroupGuard {
    #[cfg(unix)]
    group: Option<i32>,
}

impl ProcessGroupGuard {
    fn new(child: &Child) -> Self {
        #[cfg(not(unix))]
        let _ = child;
        Self {
            #[cfg(unix)]
            group: child.id().map(|pid| pid as i32),
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(group) = self.group {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
    }
}

/// Also used by the host's unsaved-buffer guard. Every positive decision,
/// including a remembered rule, must pass the same protection as Approve once.
pub fn approval_grants_permission(choice: &str) -> bool {
    choice == "accept" || choice.starts_with("accept_") || choice.starts_with("allow_network_")
}

fn approval_choice_label(choice: &str) -> String {
    match choice {
        "accept" => "Approve once",
        "accept_for_session" => "Approve for this AI conversation",
        "accept_with_execpolicy_amendment" => "Approve and remember command rule",
        "decline" => "Decline",
        "cancel" => "Stop turn",
        value if value.starts_with("allow_network_") => "Allow host and remember rule",
        value if value.starts_with("deny_network_") => "Block host and remember rule",
        _ => "Unsupported decision",
    }
    .into()
}

fn command_preview_available(params: &Value) -> bool {
    if params.get("kind").is_some_and(|kind| {
        !kind.is_null() && !matches!(kind.as_str(), Some("command" | "writeStdin"))
    }) {
        return false;
    }
    (params["command"]
        .as_str()
        .is_some_and(|command| !command.is_empty())
        && params["cwd"].as_str().is_some_and(|cwd| !cwd.is_empty()))
        || (params["networkApprovalContext"]["host"]
            .as_str()
            .is_some_and(|host| !host.is_empty())
            && params["networkApprovalContext"]["protocol"]
                .as_str()
                .is_some_and(|protocol| !protocol.is_empty()))
}

fn claude_tool_preview_available(tool: &str, input: &Value) -> bool {
    if !input.is_object() {
        return false;
    }
    let nonempty = |key: &str| input[key].as_str().is_some_and(|value| !value.is_empty());
    match tool {
        "Bash" => nonempty("command"),
        "Read" => nonempty("file_path"),
        "Glob" | "Grep" => nonempty("pattern"),
        "Edit" => {
            nonempty("file_path")
                && input["old_string"].is_string()
                && input["new_string"].is_string()
        }
        "Write" => nonempty("file_path") && input["content"].is_string(),
        _ => false,
    }
}

fn nonempty_permission_path(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|path| !path.is_empty() && !path.contains('\0'))
}

fn permission_filesystem_path_reviewable(path: &Value) -> bool {
    let Some(fields) = path.as_object() else {
        return false;
    };
    match path["type"].as_str() {
        Some("path") => fields.len() == 2 && nonempty_permission_path(&path["path"]),
        Some("glob_pattern") => fields.len() == 2 && nonempty_permission_path(&path["pattern"]),
        Some("special") if fields.len() == 2 => {
            let value = &path["value"];
            let Some(special) = value.as_object() else {
                return false;
            };
            let subpath_valid = special.get("subpath").is_none_or(|subpath| {
                subpath.is_null() || subpath.as_str().is_some_and(|path| !path.contains('\0'))
            });
            match value["kind"].as_str() {
                Some("root" | "minimal" | "tmpdir" | "slash_tmp") => special.len() == 1,
                Some("project_roots") => {
                    special
                        .keys()
                        .all(|key| matches!(key.as_str(), "kind" | "subpath"))
                        && subpath_valid
                }
                Some("unknown") => {
                    special
                        .keys()
                        .all(|key| matches!(key.as_str(), "kind" | "path" | "subpath"))
                        && nonempty_permission_path(&value["path"])
                        && subpath_valid
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// Validate the installed provider's RequestPermissionProfile before retaining
/// a positive response. Null/default objects do not describe any reviewable
/// access, and future unknown scope types must not silently gain permission.
fn permissions_preview_available(params: &Value) -> bool {
    if !nonempty_permission_path(&params["cwd"]) {
        return false;
    }
    permission_profile_reviewable(&params["permissions"])
}

fn permission_profile_reviewable(permissions: &Value) -> bool {
    let Some(profile) = permissions.as_object() else {
        return false;
    };
    if profile
        .keys()
        .any(|key| !matches!(key.as_str(), "network" | "fileSystem"))
    {
        return false;
    }
    let mut has_scope = false;
    if let Some(network) = profile.get("network").filter(|network| !network.is_null()) {
        let Some(network) = network.as_object() else {
            return false;
        };
        if network.keys().any(|key| key != "enabled") {
            return false;
        }
        if let Some(enabled) = network.get("enabled").filter(|value| !value.is_null()) {
            if !enabled.is_boolean() {
                return false;
            }
            has_scope = true;
        }
    }
    if let Some(filesystem) = profile
        .get("fileSystem")
        .filter(|filesystem| !filesystem.is_null())
    {
        let Some(fields) = filesystem.as_object() else {
            return false;
        };
        if fields.keys().any(|key| {
            !matches!(
                key.as_str(),
                "read" | "write" | "entries" | "globScanMaxDepth"
            )
        }) {
            return false;
        }
        if let Some(depth) = fields
            .get("globScanMaxDepth")
            .filter(|depth| !depth.is_null())
            && !depth.as_u64().is_some_and(|depth| depth >= 1)
        {
            return false;
        }
        for key in ["read", "write"] {
            if let Some(paths) = fields.get(key).filter(|paths| !paths.is_null()) {
                let Some(paths) = paths.as_array() else {
                    return false;
                };
                if !paths.iter().all(nonempty_permission_path) {
                    return false;
                }
                has_scope |= !paths.is_empty();
            }
        }
        if let Some(entries) = fields.get("entries").filter(|entries| !entries.is_null()) {
            let Some(entries) = entries.as_array() else {
                return false;
            };
            if !entries.iter().all(|entry| {
                entry.as_object().is_some_and(|fields| fields.len() == 2)
                    && matches!(entry["access"].as_str(), Some("read" | "write" | "deny"))
                    && permission_filesystem_path_reviewable(&entry["path"])
            }) {
                return false;
            }
            has_scope |= !entries.is_empty();
        }
    }
    has_scope
}

/// Map short browser choice IDs to the exact provider decision. Never invent a
/// decline/accept when availableDecisions explicitly omits it.
fn codex_decisions(params: &Value, kind: &str) -> Result<Vec<(String, Value)>, String> {
    if kind == "permissions" {
        return Ok(vec![
            ("accept".into(), json!("accept")),
            ("decline".into(), json!("decline")),
        ]);
    }
    let defaults = vec![json!("accept"), json!("decline"), json!("cancel")];
    let available = if params
        .get("availableDecisions")
        .is_some_and(|value| !value.is_null())
    {
        params["availableDecisions"]
            .as_array()
            .ok_or("The provider sent invalid approval choices.")?
    } else {
        &defaults
    };
    if available.len() > 16 {
        return Err("The provider sent too many approval choices.".into());
    }
    let mut result = vec![];
    for (index, decision) in available.iter().enumerate() {
        let key = match decision.as_str() {
            Some("accept" | "decline" | "cancel") => decision.as_str().unwrap().to_owned(),
            Some("acceptForSession") => "accept_for_session".into(),
            Some(_) => continue,
            None if kind == "command" => {
                let Some(object) = decision.as_object().filter(|object| object.len() == 1) else {
                    continue;
                };
                if let Some(rule) = object.get("acceptWithExecpolicyAmendment") {
                    let Some(arguments) = rule["execpolicy_amendment"].as_array().filter(|args| {
                        !args.is_empty() && args.len() <= 64 && args.iter().all(Value::is_string)
                    }) else {
                        continue;
                    };
                    if rule.as_object().is_none_or(|rule| rule.len() != 1)
                        || serde_json::to_string(arguments).unwrap_or_default().len() > MAX_DETAIL
                    {
                        continue;
                    }
                    "accept_with_execpolicy_amendment".into()
                } else if let Some(rule) = object.get("applyNetworkPolicyAmendment") {
                    let amendment = &rule["network_policy_amendment"];
                    if rule.as_object().is_none_or(|rule| rule.len() != 1)
                        || amendment.as_object().is_none_or(|rule| rule.len() != 2)
                        || !amendment["host"]
                            .as_str()
                            .is_some_and(|host| !host.is_empty() && host.len() <= 512)
                    {
                        continue;
                    }
                    match amendment["action"].as_str() {
                        Some("allow") => format!("allow_network_{index}"),
                        Some("deny") => format!("deny_network_{index}"),
                        _ => continue,
                    }
                } else {
                    continue;
                }
            }
            None => continue,
        };
        if !result.iter().any(|(existing, _)| existing == &key) {
            result.push((key, decision.clone()));
        }
    }
    if result.is_empty() {
        return Err(
            "The provider offered no supported approval decisions. The turn stopped; try a new message."
                .into(),
        );
    }
    Ok(result)
}

fn readable_fields(value: &Value, excluded: &[&str]) -> String {
    let Some(fields) = value.as_object() else {
        return if value.is_null() {
            String::new()
        } else {
            serde_json::to_string_pretty(value).unwrap_or_default()
        };
    };
    fields
        .iter()
        .filter(|(key, value)| !excluded.contains(&key.as_str()) && !value.is_null())
        .map(|(key, value)| {
            let mut title = String::new();
            for character in key.chars() {
                if character == '_' {
                    title.push(' ');
                } else if character.is_uppercase() {
                    title.push(' ');
                    title.extend(character.to_lowercase());
                } else {
                    title.push(character);
                }
            }
            if let Some(first) = title.get_mut(..1) {
                first.make_ascii_uppercase();
            }
            let text = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap_or_default());
            format!("{title}\n{text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn file_review(item: &Value) -> Option<String> {
    let changes = item["changes"]
        .as_array()
        .filter(|changes| !changes.is_empty())?;
    let mut parts = vec![];
    for change in changes {
        let path = change["path"].as_str().filter(|path| !path.is_empty())?;
        let diff = change["diff"].as_str()?;
        let extra = readable_fields(change, &["path", "diff"]);
        parts.push(format!(
            "File\n{path}\n\n{extra}{}Diff\n{diff}",
            if extra.is_empty() { "" } else { "\n\n" }
        ));
    }
    Some(parts.join("\n\n"))
}

fn approval_response(pending: &Pending, choice: &str) -> Result<Value, String> {
    match pending {
        Pending::Codex { id, method, params } => {
            let result = if method == "item/permissions/requestApproval" {
                if choice == "accept" && !permission_profile_reviewable(&params["permissions"]) {
                    return Err(
                        "This request has no complete supported permission scope to approve."
                            .into(),
                    );
                }
                json!({"permissions":if choice == "accept" {params["permissions"].clone()} else {json!({})},"scope":"turn"})
            } else {
                let decision = params["decisions"]
                    .get(choice)
                    .cloned()
                    .unwrap_or_else(|| json!(choice));
                json!({"decision":decision})
            };
            Ok(json!({"id":id,"result":result}))
        }
        Pending::Claude { id, input } => {
            let result = if choice == "accept" {
                json!({"behavior":"allow","updatedInput":input})
            } else {
                json!({"behavior":"deny","message":"The user declined this action.","interrupt":choice == "cancel"})
            };
            Ok(
                json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":result}}),
            )
        }
    }
}

fn push_message(state: &mut State, id: Option<String>, role: &str, text: &str, append: bool) {
    if text.is_empty() {
        return;
    }
    let existing = id.as_ref().and_then(|id| {
        state
            .message_ids
            .iter()
            .position(|candidate| candidate.as_ref() == Some(id))
    });
    if let Some(index) = existing {
        if append {
            state.snapshot.messages[index]
                .text
                .push_str(&clip(text, MAX_TRANSCRIPT));
        } else {
            state.snapshot.messages[index].text = clip(text, MAX_TRANSCRIPT);
        }
    } else {
        state.snapshot.messages.push(AiMessage {
            role: role.into(),
            text: clip(text, MAX_TRANSCRIPT),
        });
        state.message_ids.push(id.map(|id| clip(&id, 256)));
    }
    if text.len() > MAX_TRANSCRIPT {
        state.snapshot.truncated = true;
    }
    while state.snapshot.messages.len() > MAX_MESSAGES
        || (state.snapshot.messages.len() > 1
            && state
                .snapshot
                .messages
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                > MAX_TRANSCRIPT)
    {
        state.snapshot.messages.remove(0);
        state.message_ids.remove(0);
        state.snapshot.truncated = true;
    }
    if let Some(message) = state.snapshot.messages.first_mut()
        && message.text.len() > MAX_TRANSCRIPT
    {
        message.text = tail(&message.text, MAX_TRANSCRIPT);
        state.snapshot.truncated = true;
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.into();
    }
    let mut end = max.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
fn tail(text: &str, max: usize) -> String {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].into()
}
fn error_text(value: &Value) -> String {
    clip(
        value["message"]
            .as_str()
            .or_else(|| value["error"].as_str())
            .or_else(|| value.as_str())
            .unwrap_or("Provider could not complete this turn."),
        MAX_DETAIL,
    )
}

/// fill_buf allows the cap to be checked before allocation, unlike read_line.
async fn read_bounded_line(
    reader: &mut (impl AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
    max: usize,
) -> Result<bool, String> {
    // The caller clears the buffer only after a complete frame. A select! may
    // cancel this future between chunks to process an approval or cancellation;
    // retaining partial bytes makes the next poll safe.
    loop {
        let chunk = reader
            .fill_buf()
            .await
            .map_err(|error| format!("Provider output failed: {error}"))?;
        if chunk.is_empty() {
            return Ok(!line.is_empty());
        }
        let newline = chunk.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(chunk.len(), |index| index + 1);
        if line.len() + consumed > max {
            return Err("Provider protocol line exceeded the 256 KiB limit.".into());
        }
        line.extend_from_slice(&chunk[..consumed]);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

async fn send(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|_| "Could not encode provider message.".to_string())?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(10), async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| "Provider input timed out.".to_string())?
    .map_err(|error| format!("Provider input failed: {error}"))
}

async fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    let group = child.id();
    #[cfg(unix)]
    if let Some(pid) = group {
        // Each job starts its own process group, so terminal processes and
        // another AI job can never be targeted by this cancellation.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    if tokio::time::timeout(Duration::from_millis(300), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    // The parent may exit before descendants that ignored SIGTERM. Keep its
    // original group ID until cleanup is complete, even after it is reaped.
    #[cfg(unix)]
    if let Some(pid) = group {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

fn resolve_binary(id: &str) -> Option<PathBuf> {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(id))
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".local/bin").join(id));
    }
    paths.into_iter().find_map(|path| {
        if is_executable(&path) {
            std::fs::canonicalize(path).ok()
        } else {
            None
        }
    })
}
fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

async fn auth_probe(binary: &Path, args: &[&str], provider: &str) -> (String, String) {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let Ok(mut child) = command.spawn() else {
        return ("unknown".into(), "Could not check CLI sign-in.".into());
    };
    let _group_guard = ProcessGroupGuard::new(&child);
    let mut stdout = child.stdout.take().unwrap().take(16 * 1024);
    let mut stderr = child.stderr.take().unwrap().take(4096);
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_result, err_result) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        out_result?;
        err_result?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status.success(), out, err))
    })
    .await;
    let Ok(Ok((success, out, err))) = result else {
        stop_child(&mut child).await;
        return (
            "unknown".into(),
            "CLI sign-in status check timed out or failed.".into(),
        );
    };
    if provider == "claude" {
        if let Ok(value) = serde_json::from_slice::<Value>(&out) {
            if value["loggedIn"] == true {
                let subscription = value["authMethod"] == "claude.ai";
                return ("signed_in".into(),if subscription {"Signed in through Claude Code with a Claude account. Usage follows your own account limits."} else {"Claude Code is signed in using its configured authentication method."}.into());
            }
            if value["loggedIn"] == false {
                return (
                    "signed_out".into(),
                    "Sign in on the host with `claude auth login`.".into(),
                );
            }
        }
    } else {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out),
            String::from_utf8_lossy(&err)
        );
        if success && text.contains("Logged in") {
            return (
                "signed_in".into(),
                if text.contains("ChatGPT") {
                    "Signed in through Codex with ChatGPT. Usage follows your own account limits."
                } else {
                    "Codex is signed in using its configured authentication method."
                }
                .into(),
            );
        }
        if text.contains("Not logged in") {
            return (
                "signed_out".into(),
                "Sign in on the host with `codex login`.".into(),
            );
        }
    }
    ("unknown".into(),"The CLI did not report a recognized sign-in status. Check its configuration in the host terminal.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_managers_inherit_configuration_without_sharing_conversation_or_process() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let host = AiManager::with_binaries(first.path().into(), Arc::new(|| {}), HashMap::new());
        {
            let mut state = host.state.lock().unwrap();
            state.settings.codex.model = Some("fixture-model".into());
            state.snapshot.status = "running".into();
            state.snapshot.session_id = Some("primary-conversation".into());
            push_message(&mut state, None, "assistant", "primary text", false);
        }
        let fork = host.for_project(second.path().into(), Arc::new(|| {}));
        assert_eq!(fork.settings(), host.settings());
        assert_eq!(fork.providers().len(), host.providers().len());
        assert_eq!(fork.state.lock().unwrap().workspace, second.path());
        assert!(fork.snapshot().messages.is_empty());
        assert!(fork.snapshot().session_id.is_none());
        assert!(!fork.is_busy());
        assert!(fork.state.lock().unwrap().pending.is_empty());
        host.state.lock().unwrap().settings.codex.model = Some("updated-model".into());
        fork.inherit_host_configuration(&host);
        assert_eq!(
            fork.settings().codex.model.as_deref(),
            Some("updated-model")
        );
        assert_eq!(
            host.snapshot().session_id.as_deref(),
            Some("primary-conversation")
        );
    }

    #[tokio::test]
    async fn line_decoder_checks_cap_before_growing_buffer() {
        let mut reader = BufReader::new(&b"123456789\n"[..]);
        let mut line = vec![];
        assert!(read_bounded_line(&mut reader, &mut line, 4).await.is_err());
        assert!(line.len() <= 4);
        let mut reader = BufReader::new(&b"{\"text\":\"\xc3\xa9\"}\nlast"[..]);
        assert!(
            read_bounded_line(&mut reader, &mut line, 100)
                .await
                .unwrap()
        );
        assert_eq!(serde_json::from_slice::<Value>(&line).unwrap()["text"], "é");
        line.clear();
        assert!(
            read_bounded_line(&mut reader, &mut line, 100)
                .await
                .unwrap()
        );
        assert_eq!(line, b"last");
        line.clear();
        assert!(
            !read_bounded_line(&mut reader, &mut line, 100)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn partial_frame_survives_control_interrupting_the_reader() {
        let (mut writer, reader) = tokio::io::duplex(128);
        let mut reader = BufReader::new(reader);
        let mut line = vec![];
        writer.write_all(b"{\"text\":\"").await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                read_bounded_line(&mut reader, &mut line, 100)
            )
            .await
            .is_err()
        );
        assert_eq!(line, b"{\"text\":\"");
        writer.write_all("é\"}\n".as_bytes()).await.unwrap();
        assert!(
            read_bounded_line(&mut reader, &mut line, 100)
                .await
                .unwrap()
        );
        assert_eq!(serde_json::from_slice::<Value>(&line).unwrap()["text"], "é");
    }

    #[test]
    fn bounded_transcript_replaces_final_stream_text_and_handles_unicode() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let mut state = manager.state.lock().unwrap();
        push_message(&mut state, Some("a".into()), "assistant", "partial", true);
        push_message(&mut state, Some("a".into()), "assistant", "final", false);
        assert_eq!(state.snapshot.messages.len(), 1);
        assert_eq!(state.snapshot.messages[0].text, "final");
        for _ in 0..200 {
            push_message(&mut state, None, "tool", &"é".repeat(1000), false);
        }
        assert!(state.snapshot.messages.len() <= MAX_MESSAGES);
        assert!(
            state
                .snapshot
                .messages
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                <= MAX_TRANSCRIPT
        );
        assert!(state.snapshot.truncated);
        push_message(
            &mut state,
            Some("large".into()),
            "assistant",
            &"🙂".repeat(MAX_TRANSCRIPT),
            false,
        );
        push_message(&mut state, Some("large".into()), "assistant", "🙂", true);
        assert!(
            state
                .snapshot
                .messages
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                <= MAX_TRANSCRIPT
        );
    }

    #[test]
    fn permissions_are_one_time_and_preserve_exact_tool_input() {
        let input = json!({"file_path":"space name.rs","new_string":"quotes \" and $()"});
        let response = approval_response(
            &Pending::Claude {
                id: "request1".into(),
                input: input.clone(),
            },
            "accept",
        )
        .unwrap();
        assert_eq!(
            response.pointer("/response/response/updatedInput"),
            Some(&input)
        );
        assert!(
            response
                .pointer("/response/response/updatedPermissions")
                .is_none()
        );
        let response = approval_response(
            &Pending::Codex {
                id: json!(2),
                method: "item/permissions/requestApproval".into(),
                params: json!({"permissions":{"network":{"enabled":true}}}),
            },
            "decline",
        )
        .unwrap();
        assert_eq!(response["result"]["permissions"], json!({}));
        assert_eq!(response["result"]["scope"], "turn");
    }

    #[test]
    fn repeated_approval_id_cannot_grow_the_review_queue() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let pending = Pending::Claude {
            id: "same".into(),
            input: json!({"file_path":"test"}),
        };
        manager
            .add_approval(
                0,
                "same".into(),
                pending.clone(),
                "file",
                "Edit",
                "preview",
                vec!["accept".into()],
            )
            .unwrap();
        for _ in 0..100 {
            assert!(
                manager
                    .add_approval(
                        0,
                        "same".into(),
                        pending.clone(),
                        "file",
                        "Edit",
                        "preview",
                        vec!["accept".into()]
                    )
                    .is_err()
            );
        }
        assert_eq!(manager.snapshot().approvals.len(), 1);
    }

    #[test]
    fn oversized_action_cannot_be_accepted_or_retain_its_full_input() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let input = json!({"content":"large".repeat(MAX_DETAIL)});
        manager
            .add_approval(
                0,
                "large".into(),
                Pending::Claude {
                    id: "large".into(),
                    input,
                },
                "file",
                "Write",
                &"large".repeat(MAX_DETAIL),
                vec!["accept".into(), "decline".into()],
            )
            .unwrap();
        let snapshot = manager.snapshot();
        assert!(!snapshot.approvals[0].choices.contains(&"accept".into()));
        assert!(snapshot.approvals[0].disabled_reason.is_some());
        assert!(snapshot.approvals[0].detail.len() <= MAX_DETAIL);
        let state = manager.state.lock().unwrap();
        assert!(matches!(
            &state.pending["large"],
            Pending::Claude {
                input: Value::Null,
                ..
            }
        ));
    }

    #[test]
    fn screenshot_command_metadata_does_not_hide_the_complete_action() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let command = "/bin/zsh -lc 'sed -n 155,310p ECONOMY.md'";
        let amendment = json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["sed","-n","155,310p","ECONOMY.md"]}});
        let params = json!({
            "command":command,"cwd":"/tmp/fixture-project","reason":"Read the saved project notes",
            "threadId":"t".repeat(400),"turnId":"r".repeat(400),"itemId":"exec-item",
            "aggregatedOutput":"irrelevant provider result".repeat(200),"startedAtMs":1234,
            "commandActions":[{"type":"read","command":command,"path":"/tmp/fixture-project/ECONOMY.md"}],
            "availableDecisions":["accept",amendment,"cancel"],
        });
        assert!(serde_json::to_string(&params).unwrap().len() > MAX_DETAIL);
        let detail = manager.approval_detail("command", &params);
        assert!(detail.len() < MAX_DETAIL);
        assert!(detail.contains(command));
        assert!(detail.contains("/tmp/fixture-project"));
        assert!(!detail.contains("aggregatedOutput"));
        assert!(!detail.contains("threadId"));
        let decisions = codex_decisions(&params, "command").unwrap();
        let choices = decisions
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            choices,
            ["accept", "accept_with_execpolicy_amendment", "cancel"]
        );
        assert!(!choices.contains(&"decline".into()));
        let pending = Pending::Codex {
            id: json!(9),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"decisions":decisions.into_iter().collect::<serde_json::Map<String,Value>>()}),
        };
        assert_eq!(
            approval_response(&pending, "accept").unwrap()["result"]["decision"],
            "accept"
        );
        assert_eq!(
            approval_response(&pending, "accept_with_execpolicy_amendment").unwrap()["result"]["decision"],
            amendment
        );
        manager
            .add_approval(
                0,
                "request".into(),
                pending,
                "command",
                "Approve command",
                &detail,
                choices,
            )
            .unwrap();
        assert!(
            manager.snapshot().approvals[0]
                .choices
                .contains(&"accept".into())
        );
        assert!(manager.snapshot().approvals[0].disabled_reason.is_none());
    }

    #[test]
    fn long_contextual_reason_does_not_block_a_complete_small_command() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let reason = "Context about this read operation 🙂 ".repeat(MAX_DETAIL);
        let params = json!({"command":"sed -n 1,20p example.md","cwd":"/tmp/fixture-project","reason":reason});
        let detail = manager.approval_detail("command", &params);
        assert!(detail.len() < MAX_DETAIL);
        assert!(detail.contains("sed -n 1,20p example.md"));
        assert!(!detail.contains("Context about"));
        let decisions = codex_decisions(&params, "command").unwrap();
        let choices = decisions
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let pending = Pending::Codex {
            id: json!(1),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"decisions":decisions.into_iter().collect::<serde_json::Map<String,Value>>()}),
        };
        manager
            .add_approval(
                0,
                "small".into(),
                pending,
                "command",
                params["reason"].as_str().unwrap(),
                &detail,
                choices,
            )
            .unwrap();
        let approval = &manager.snapshot().approvals[0];
        assert!(approval.choices.contains(&"accept".into()));
        assert!(approval.disabled_reason.is_none());
        assert!(approval.title.len() <= 256);
        assert!(approval.title.ends_with('…'));
        let oversized_params = json!({"command":"🙂".repeat(MAX_DETAIL),"cwd":"/tmp/fixture-project","reason":"A short contextual reason"});
        let oversized_detail = manager.approval_detail("command", &oversized_params);
        manager
            .add_approval(
                0,
                "large".into(),
                Pending::Codex {
                    id: json!(2),
                    method: "item/commandExecution/requestApproval".into(),
                    params: json!({"decisions":{"accept":"accept","cancel":"cancel"}}),
                },
                "command",
                "A short reason",
                &oversized_detail,
                vec!["accept".into(), "cancel".into()],
            )
            .unwrap();
        let large = &manager.snapshot().approvals[1];
        assert!(
            !large
                .choices
                .iter()
                .any(|choice| approval_grants_permission(choice))
        );
        assert!(large.disabled_reason.is_some());
        assert!(!command_preview_available(
            &json!({"command":null,"networkApprovalContext":{"host":"example.test","protocol":""}})
        ));
    }

    #[test]
    fn explicit_provider_choices_and_session_rules_are_exact_and_bounded() {
        let network = json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"example.test","action":"allow"}}});
        let params = json!({"availableDecisions":["acceptForSession",network,"cancel","unknown"]});
        let decisions = codex_decisions(&params, "command").unwrap();
        assert_eq!(
            decisions
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            ["accept_for_session", "allow_network_1", "cancel"]
        );
        let pending = Pending::Codex {
            id: json!(1),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"decisions":decisions.into_iter().collect::<serde_json::Map<String,Value>>()}),
        };
        assert_eq!(
            approval_response(&pending, "accept_for_session").unwrap()["result"]["decision"],
            "acceptForSession"
        );
        assert_eq!(
            approval_response(&pending, "allow_network_1").unwrap()["result"]["decision"],
            network
        );
        assert!(approval_grants_permission("accept_for_session"));
        assert!(approval_grants_permission("allow_network_1"));
        assert!(!approval_grants_permission("deny_network_1"));
        assert!(codex_decisions(&json!({"availableDecisions":["unknown"]}), "command").is_err());
        assert!(
            codex_decisions(&json!({"availableDecisions":vec!["accept";17]}), "command").is_err()
        );
        assert!(codex_decisions(&json!({"availableDecisions":"accept"}), "command").is_err());
        assert!(!command_preview_available(
            &json!({"command":null,"commandActions":[]})
        ));
        assert!(command_preview_available(
            &json!({"command":null,"networkApprovalContext":{"host":"example.test","protocol":"https"}})
        ));
        assert!(!command_preview_available(
            &json!({"kind":"unknownAction","command":"echo test","cwd":"/tmp"})
        ));
        assert!(!command_preview_available(&json!({"command":"echo test"})));
        assert!(command_preview_available(
            &json!({"command":"echo test","cwd":"/tmp"})
        ));
    }

    #[test]
    fn readable_file_review_excludes_result_metadata_and_requires_every_diff() {
        let item = json!({"id":"exec","type":"fileChange","status":"inProgress","changes":[{"path":"example.rs","kind":{"type":"update"},"diff":"-old\n+new"}],"aggregatedOutput":"x".repeat(MAX_DETAIL)});
        let review = file_review(&item).unwrap();
        assert!(review.contains("example.rs"));
        assert!(review.contains("-old\n+new"));
        assert!(!review.contains("aggregatedOutput"));
        assert!(
            file_review(&json!({"changes":[{"path":"a","diff":"-a\n+b"},{"path":"b"}]})).is_none()
        );
        assert!(claude_tool_preview_available(
            "Bash",
            &json!({"command":"printf example"})
        ));
        assert!(!claude_tool_preview_available(
            "Bash",
            &json!({"description":"missing command"})
        ));
        assert!(!claude_tool_preview_available(
            "UnknownTool",
            &json!({"command":"printf example"})
        ));
        assert!(!claude_tool_preview_available(
            "Edit",
            &json!({"file_path":"test.rs","new_string":"replacement"})
        ));
    }

    #[test]
    fn legacy_settings_default_to_ask_and_invalid_permission_modes_fail_closed() {
        let legacy: AiSettings =
            serde_json::from_value(json!({"defaultProvider":"codex","codex":{},"claude":{}}))
                .unwrap();
        assert_eq!(legacy.permission_mode, PermissionMode::Ask);
        assert_eq!(
            serde_json::to_value(legacy).unwrap()["permissionMode"],
            "ask"
        );
        assert!(serde_json::from_value::<AiSettings>(json!({"permissionMode":"full"})).is_err());
        assert!(serde_json::from_value::<AiSettings>(json!({"permissionMode":true})).is_err());
    }

    #[test]
    fn permission_profiles_require_complete_known_scope_and_preserve_valid_wire_values() {
        let invalid = [
            Value::Null,
            json!({}),
            json!([]),
            json!("all"),
            json!(true),
            json!({"network":null}),
            json!({"network":{}}),
            json!({"network":{"enabled":null}}),
            json!({"network":{"enabled":"yes"}}),
            json!({"network":true}),
            json!({"network":{"enabled":true,"allHosts":true}}),
            json!({"fullAccess":true}),
            json!({"fileSystem":{}}),
            json!({"fileSystem":{"read":[],"write":null,"entries":[]}}),
            json!({"fileSystem":{"write":"/tmp"}}),
            json!({"fileSystem":{"write":[""]}}),
            json!({"fileSystem":{"write":["/tmp"],"globScanMaxDepth":0}}),
            json!({"fileSystem":{"arbitraryScope":true}}),
            json!({"fileSystem":{"entries":[{"access":"execute","path":{"type":"path","path":"/tmp"}}]}}),
            json!({"fileSystem":{"entries":[{"access":"write","path":{"type":"unknownCoreType","path":"/tmp"}}]}}),
            json!({"fileSystem":{"entries":[{"access":"write","path":{"type":"special","value":{"kind":"futureRoot"}}}]}}),
        ];
        for permissions in invalid {
            assert!(
                !permissions_preview_available(
                    &json!({"cwd":"/tmp/fixture","permissions":permissions})
                ),
                "{permissions}"
            );
            let pending = Pending::Codex {
                id: json!(1),
                method: "item/permissions/requestApproval".into(),
                params: json!({"permissions":permissions}),
            };
            assert!(approval_response(&pending, "accept").is_err());
            assert_eq!(
                approval_response(&pending, "decline").unwrap()["result"]["permissions"],
                json!({})
            );
        }
        assert!(!permissions_preview_available(
            &json!({"cwd":"/tmp/fixture"})
        ));
        assert!(!permissions_preview_available(
            &json!({"permissions":{"network":{"enabled":true}}})
        ));
        let valid = [
            json!({"network":{"enabled":true}}),
            json!({"network":{"enabled":false}}),
            json!({"fileSystem":{"write":["/tmp/fixture/ECONOMY.md"]},"network":{"enabled":true}}),
            json!({"fileSystem":{"read":["/tmp/fixture"],"globScanMaxDepth":2}}),
            json!({"fileSystem":{"entries":[{"access":"write","path":{"type":"path","path":"/tmp/fixture"}},{"access":"deny","path":{"type":"glob_pattern","pattern":"**/.env"}},{"access":"read","path":{"type":"special","value":{"kind":"project_roots","subpath":null}}}]}}),
        ];
        for permissions in valid {
            assert!(
                permissions_preview_available(
                    &json!({"cwd":"/tmp/fixture","permissions":permissions})
                ),
                "{permissions}"
            );
            let pending = Pending::Codex {
                id: json!(2),
                method: "item/permissions/requestApproval".into(),
                params: json!({"permissions":permissions}),
            };
            let result = approval_response(&pending, "accept").unwrap();
            assert_eq!(result["result"]["permissions"], permissions);
            assert_eq!(result["result"]["scope"], "turn");
        }
    }

    #[test]
    fn oversized_unicode_permission_scope_cannot_be_granted_or_retained() {
        let manager =
            AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let permissions =
            json!({"fileSystem":{"write":[format!("/tmp/{}","🙂".repeat(MAX_DETAIL))]}});
        let params = json!({"cwd":"/tmp/fixture","permissions":permissions});
        assert!(permissions_preview_available(&params));
        let detail = manager.approval_detail("permissions", &params);
        assert!(detail.contains("Working directory\n/tmp/fixture"));
        assert!(detail.len() > MAX_DETAIL);
        manager
            .add_approval(
                0,
                "large-scope".into(),
                Pending::Codex {
                    id: json!(1),
                    method: "item/permissions/requestApproval".into(),
                    params: json!({"permissions":permissions}),
                },
                "permissions",
                "Approve additional permissions",
                &detail,
                vec!["accept".into(), "decline".into()],
            )
            .unwrap();
        let approval = &manager.snapshot().approvals[0];
        assert_eq!(approval.choices, ["decline"]);
        assert!(approval.disabled_reason.is_some());
        assert!(approval.detail.len() <= MAX_DETAIL);
        let state = manager.state.lock().unwrap();
        assert!(
            matches!(&state.pending["large-scope"],Pending::Codex{params,..} if params["permissions"].is_null())
        );
    }

    #[test]
    fn shared_permission_changes_reset_dormant_sessions_without_enabling_full_access_implicitly() {
        let host = AiManager::with_binaries(PathBuf::from("/tmp"), Arc::new(|| {}), HashMap::new());
        let project = host.for_project(PathBuf::from("/tmp/fixture"), Arc::new(|| {}));
        {
            let mut state = project.state.lock().unwrap();
            state.snapshot.session_id = Some("old-read-only-session".into());
            push_message(&mut state, None, "assistant", "Old session", false);
        }
        assert_eq!(project.settings().permission_mode, PermissionMode::Ask);
        let mut changed = host.settings();
        changed.permission_mode = PermissionMode::FullAccess;
        project.apply_shared_settings(&changed);
        assert!(project.snapshot().session_id.is_none());
        assert!(project.snapshot().messages.is_empty());
        assert_eq!(
            project.settings().permission_mode,
            PermissionMode::FullAccess
        );
        project.inherit_host_configuration(&host);
        assert_eq!(project.settings().permission_mode, PermissionMode::Ask);
    }

    #[cfg(unix)]
    #[test]
    fn settings_are_private_persisted_normalized_and_invalid_updates_are_inert() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, manager) = fixture("codex", "exit 0");
        let settings = AiSettings {
            default_provider: "claude".into(),
            permission_mode: PermissionMode::Ask,
            codex: CodexSettings {
                model: Some("  fixture-codex  ".into()),
                reasoning_effort: Some(" high ".into()),
            },
            claude: ClaudeSettings {
                model: Some(" opus[1m] ".into()),
            },
        };
        let accepted = manager.configure(settings).unwrap();
        assert_eq!(accepted.codex.model.as_deref(), Some("fixture-codex"));
        assert_eq!(accepted.codex.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(accepted.claude.model.as_deref(), Some("opus[1m]"));
        let saved_path = dir.path().join("ai-settings.json");
        let persisted = fs::read(&saved_path).unwrap();
        assert_eq!(
            fs::metadata(&saved_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(load_settings(&saved_path).unwrap(), Some(accepted.clone()));
        let reloaded = AiManager::new_with_settings_path(
            dir.path().to_owned(),
            Arc::new(|| {}),
            saved_path.clone(),
        );
        assert_eq!(reloaded.settings(), accepted);
        assert_eq!(reloaded.settings_error(), None);
        {
            let mut state = manager.state.lock().unwrap();
            state.snapshot.session_id = Some("keep-this-session".into());
            push_message(
                &mut state,
                None,
                "assistant",
                "Preserve prior transcript on failure",
                false,
            );
        }
        for value in [
            "--dangerously-skip-permissions".to_owned(),
            "bad model".into(),
            "bad\nmodel".into(),
            "x".repeat(129),
        ] {
            let mut invalid = accepted.clone();
            invalid.claude.model = Some(value);
            assert!(manager.configure(invalid).is_err());
        }
        let mut invalid = accepted.clone();
        invalid.default_provider = "unknown-provider".into();
        assert!(manager.configure(invalid).is_err());
        let mut invalid = accepted.clone();
        invalid.codex.reasoning_effort = Some("arbitrary input with spaces".into());
        assert!(manager.configure(invalid).is_err());
        assert_eq!(manager.settings(), accepted);
        assert_eq!(fs::read(&saved_path).unwrap(), persisted);
        assert_eq!(
            manager.snapshot().session_id.as_deref(),
            Some("keep-this-session")
        );
        assert_eq!(manager.snapshot().messages.len(), 1);
        assert!(
            serde_json::from_value::<AiSettings>(json!({"apiKey":"must-not-be-retained"})).is_err()
        );
        let mut defaults = accepted;
        defaults.codex.model = Some(" ".into());
        defaults.codex.reasoning_effort = Some(" ".into());
        defaults.claude.model = Some(" ".into());
        let defaults = manager.configure(defaults).unwrap();
        assert_eq!(defaults.codex, CodexSettings::default());
        assert_eq!(defaults.claude, ClaudeSettings::default());
        assert!(manager.snapshot().session_id.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn settings_files_reject_symlinks_oversize_and_preserve_state_on_write_failure() {
        let (dir, mut manager) = fixture("codex", "exit 0");
        let target = dir.path().join("outside.json");
        fs::write(&target, b"{}\n").unwrap();
        let link = dir.path().join("linked-settings.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(load_settings(&link).is_err());
        manager.settings_path = Some(link);
        let before = manager.settings();
        let mut changed = before.clone();
        changed.codex.model = Some("fixture-changed".into());
        assert!(manager.configure(changed).is_err());
        assert_eq!(manager.settings(), before);
        assert_eq!(fs::read(&target).unwrap(), b"{}\n");
        fs::write(&target, vec![b' '; MAX_SETTINGS + 1]).unwrap();
        assert!(load_settings(&target).is_err());
        fs::write(&target, b"{\"apiKey\":\"credential-must-not-appear\"}").unwrap();
        let loaded =
            AiManager::new_with_settings_path(dir.path().to_owned(), Arc::new(|| {}), target);
        let error = loaded.settings_error().unwrap();
        assert!(!error.contains("credential-must-not-appear"));
        assert_eq!(loaded.settings().codex.model, None);
        let snapshot = manager.snapshot();
        assert!(
            manager
                .switch_workspace(dir.path().join("missing-project"))
                .is_err()
        );
        assert_eq!(manager.snapshot().status, snapshot.status);
        assert_eq!(manager.settings(), before);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_refresh_is_deduplicated_and_never_retains_personal_fields() {
        let (_dir, manager) = fixture(
            "claude",
            r#"sleep 0.1; printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"private@example.test","apiKey":"private-fixture-key","accountId":"private-account"}'"#,
        );
        let first_manager = manager.clone();
        let first = tokio::spawn(async move { first_manager.refresh_auth_checked().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(manager.refresh_auth_checked().await.is_err());
        first.await.unwrap().unwrap();
        let providers = manager.providers();
        let claude = providers
            .iter()
            .find(|provider| provider.id == "claude")
            .unwrap();
        assert_eq!(claude.auth, "signed_in");
        assert_eq!(claude.login_command, "claude auth login");
        assert!(claude.binary_path.is_some());
        let serialized = serde_json::to_string(&providers).unwrap();
        assert!(!serialized.contains("private@example.test"));
        assert!(!serialized.contains("private-fixture-key"));
        assert!(!serialized.contains("private-account"));
    }

    #[cfg(unix)]
    fn fixture(provider: &str, script: &str) -> (tempfile::TempDir, AiManager) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join(provider);
        std::fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut manager = AiManager::with_binaries(
            dir.path().to_owned(),
            Arc::new(|| {}),
            HashMap::from([(provider.into(), binary)]),
        );
        manager.settings_path = Some(dir.path().join("ai-settings.json"));
        (dir, manager)
    }

    #[cfg(unix)]
    async fn wait_status(manager: &AiManager, expected: &str) -> AiSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = manager.snapshot();
                if snapshot.status == expected {
                    return snapshot;
                }
                assert_ne!(snapshot.status, "error", "{:?}", snapshot.error);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Expected {expected}, got {:?}", manager.snapshot()))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_codex_stream_approval_followup_and_resume() {
        let (dir, manager) = fixture(
            "codex",
            r#"
while IFS= read -r frame; do
  printf '%s\n' "$frame" >> "$0.frames"
  case "$frame" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{"userAgent":"fake"}}' ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"test-thread"}}}' ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"test-turn"}}}' '{"method":"item/agentMessage/delta","params":{"itemId":"reply","delta":"part"}}' '{"method":"item/started","params":{"item":{"id":"file","type":"fileChange","changes":[{"path":"example.rs","diff":"-old\n+new"}]}}}' '{"id":9,"method":"item/fileChange/requestApproval","params":{"itemId":"file","threadId":"test-thread","turnId":"test-turn","reason":"Update example"}}'
      ;;
    *'"decision":"accept"'*) printf '%s\n' '{"method":"item/completed","params":{"item":{"id":"reply","type":"agentMessage","text":"Done é"}}}' '{"method":"turn/completed","params":{"turn":{"id":"test-turn","status":"completed","error":null}}}' ;;
  esac
done
"#,
        );
        let mut settings = manager.settings();
        settings.codex.model = Some("fixture-codex".into());
        settings.codex.reasoning_effort = Some("high".into());
        manager.configure(settings.clone()).unwrap();
        let started = manager
            .start("codex", "A literal $() and `value`", Some("space name.rs"))
            .unwrap();
        assert_eq!(started.messages[0].text, "A literal $() and `value`");
        assert!(manager.start("codex", "Duplicate", None).is_err());
        let snapshot = wait_status(&manager, "awaiting_approval").await;
        assert!(manager.is_busy());
        assert!(manager.configure(AiSettings::default()).is_err());
        let target = tempfile::tempdir().unwrap();
        assert!(manager.switch_workspace(target.path().to_owned()).is_err());
        assert_eq!(manager.settings(), settings);
        assert_eq!(snapshot.approvals.len(), 1);
        let id = &snapshot.approvals[0].id;
        manager.approve(id, "accept").unwrap();
        assert!(manager.approve(id, "accept").is_err());
        let complete = wait_status(&manager, "complete").await;
        let assistant: Vec<_> = complete
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .collect();
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0].text, "Done é");
        assert_eq!(complete.session_id.as_deref(), Some("test-thread"));
        manager.start("codex", "Follow up", None).unwrap();
        let snapshot = wait_status(&manager, "awaiting_approval").await;
        manager
            .approve(&snapshot.approvals[0].id, "accept")
            .unwrap();
        wait_status(&manager, "complete").await;
        let frames = std::fs::read_to_string(dir.path().join("codex.frames")).unwrap();
        assert!(frames.contains("thread/resume"));
        assert!(frames.contains("read-only"));
        assert!(frames.contains("on-request"));
        assert!(frames.contains("A literal $() and `value`"));
        assert!(frames.contains("The user is viewing this workspace file: space name.rs"));
        let frames: Vec<Value> = frames
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for frame in frames.iter().filter(|frame| {
            matches!(
                frame["method"].as_str(),
                Some("thread/start" | "thread/resume")
            )
        }) {
            assert_eq!(frame["params"]["model"], "fixture-codex");
            assert_eq!(frame["params"]["config"]["model_reasoning_effort"], "high");
        }
        for frame in frames
            .iter()
            .filter(|frame| frame["method"] == "turn/start")
        {
            assert_eq!(frame["params"]["model"], "fixture-codex");
            assert_eq!(frame["params"]["effort"], "high");
        }
        assert!(!manager.is_busy());
        manager.configure(AiSettings::default()).unwrap();
        assert_eq!(manager.snapshot().status, "idle");
        assert!(manager.snapshot().session_id.is_none());
        assert!(manager.snapshot().messages.is_empty());
        manager.switch_workspace(target.path().to_owned()).unwrap();
        manager
            .start("codex", "New project with native defaults", None)
            .unwrap();
        let snapshot = wait_status(&manager, "awaiting_approval").await;
        manager
            .approve(&snapshot.approvals[0].id, "decline")
            .unwrap();
        manager.cancel().unwrap();
        wait_status(&manager, "cancelled").await;
        let frames: Vec<Value> = std::fs::read_to_string(dir.path().join("codex.frames"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let thread = frames
            .iter()
            .rev()
            .find(|frame| {
                matches!(
                    frame["method"].as_str(),
                    Some("thread/start" | "thread/resume")
                )
            })
            .unwrap();
        assert_eq!(thread["method"], "thread/start");
        assert_eq!(
            thread["params"]["cwd"],
            json!(fs::canonicalize(target.path()).unwrap())
        );
        assert!(thread["params"].get("model").is_none());
        assert!(thread["params"].get("config").is_none());
        let turn = frames
            .iter()
            .rev()
            .find(|frame| frame["method"] == "turn/start")
            .unwrap();
        assert!(turn["params"].get("model").is_none());
        assert!(turn["params"].get("effort").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_claude_host_permissions_stream_and_subscription_flags() {
        let (dir, manager) = fixture(
            "claude",
            r#"
printf '%s\n' "$@" > "$0.args"
while IFS= read -r frame; do
  printf '%s\n' "$frame" >> "$0.frames"
  case "$frame" in
    *'"subtype":"initialize"'*) printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"editor-init","response":{}}}' ;;
    *'"type":"user"'*)
      printf '%s\n' '{"type":"system","session_id":"test-session","subtype":"init"}' '{"type":"stream_event","event":{"type":"message_start","message":{"id":"reply"}}}' '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}}' '{"type":"control_request","request_id":"change1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"test.rs","old_string":"old value","new_string":"quotes and $()"}}}'
      ;;
    *'"behavior":"allow"'*) printf '%s\n' '{"type":"assistant","message":{"id":"reply","content":[{"type":"text","text":"Complete é"}]}}' '{"type":"result","subtype":"success","is_error":false,"session_id":"test-session","result":"Complete é"}' ;;
  esac
done
"#,
        );
        let mut settings = manager.settings();
        settings.claude.model = Some("fixture-claude[1m]".into());
        manager.configure(settings).unwrap();
        manager.start("claude", "Help", None).unwrap();
        let snapshot = wait_status(&manager, "awaiting_approval").await;
        manager
            .approve(&snapshot.approvals[0].id, "accept")
            .unwrap();
        let snapshot = wait_status(&manager, "complete").await;
        let assistant: Vec<_> = snapshot
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .collect();
        assert_eq!(assistant.len(), 1);
        assert_eq!(assistant[0].text, "Complete é");
        assert_eq!(snapshot.session_id.as_deref(), Some("test-session"));
        let args = std::fs::read_to_string(dir.path().join("claude.args")).unwrap();
        assert!(args.contains("manual"));
        assert!(args.contains("--permission-prompt-tool\nstdio"));
        assert!(args.contains("--model\nfixture-claude[1m]\n"));
        assert!(!args.contains("--bare"));
        assert!(!args.contains("--dangerously-skip-permissions"));
        let frames = std::fs::read_to_string(dir.path().join("claude.frames")).unwrap();
        assert!(frames.contains("quotes and $()"));
        assert!(!frames.contains("updatedPermissions"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_full_access_reaches_codex_wire_and_switching_back_does_not_resume_it() {
        let (dir, manager) = fixture(
            "codex",
            r#"
while IFS= read -r frame; do
  printf '%s\n' "$frame" >> "$0.frames"
  case "$frame" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"fixture-thread"}}}' ;;
    *'"method":"turn/start"'*) printf '%s\n' '{"id":3,"result":{"turn":{"id":"fixture-turn"}}}' '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}' ;;
  esac
done
"#,
        );
        assert_eq!(manager.settings().permission_mode, PermissionMode::Ask);
        let mut settings = manager.settings();
        settings.permission_mode = PermissionMode::FullAccess;
        manager.configure(settings).unwrap();
        assert_eq!(
            load_settings(&dir.path().join("ai-settings.json"))
                .unwrap()
                .unwrap()
                .permission_mode,
            PermissionMode::FullAccess
        );
        manager.start("codex", "Full access fixture", None).unwrap();
        wait_status(&manager, "complete").await;
        assert!(manager.snapshot().session_id.is_some());
        manager.configure(AiSettings::default()).unwrap();
        assert!(manager.snapshot().session_id.is_none());
        manager.start("codex", "Ask fixture", None).unwrap();
        wait_status(&manager, "complete").await;
        let frames = fs::read_to_string(dir.path().join("codex.frames"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let threads = frames
            .iter()
            .filter(|frame| frame["method"] == "thread/start")
            .collect::<Vec<_>>();
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0]["params"]["approvalPolicy"], "never");
        assert_eq!(threads[0]["params"]["sandbox"], "danger-full-access");
        assert!(
            threads[0]["params"]["developerInstructions"]
                .as_str()
                .unwrap()
                .contains("explicitly enabled full access")
        );
        assert_eq!(threads[1]["params"]["approvalPolicy"], "on-request");
        assert_eq!(threads[1]["params"]["sandbox"], "read-only");
        let turns = frames
            .iter()
            .filter(|frame| frame["method"] == "turn/start")
            .collect::<Vec<_>>();
        assert_eq!(turns[0]["params"]["approvalPolicy"], "never");
        assert_eq!(
            turns[0]["params"]["sandboxPolicy"],
            json!({"type":"dangerFullAccess"})
        );
        assert_eq!(turns[1]["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            turns[1]["params"]["sandboxPolicy"],
            json!({"type":"readOnly","networkAccess":false})
        );
        assert!(
            !frames
                .iter()
                .any(|frame| frame["method"] == "thread/resume")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_full_access_reaches_claude_native_flags_and_does_not_leak_back_to_ask() {
        let (dir, manager) = fixture(
            "claude",
            r#"
printf '%s\n' "$@" > "$0.args"
while IFS= read -r frame; do
  printf '%s\n' "$frame" >> "$0.frames"
  case "$frame" in
    *'"subtype":"initialize"'*) printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"editor-init","response":{}}}' ;;
    *'"type":"user"'*) printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"fixture-session","result":"Fixture done"}' ;;
  esac
done
"#,
        );
        let mut settings = manager.settings();
        settings.permission_mode = PermissionMode::FullAccess;
        manager.configure(settings).unwrap();
        manager
            .start("claude", "Full access fixture", None)
            .unwrap();
        wait_status(&manager, "complete").await;
        let args = fs::read_to_string(dir.path().join("claude.args")).unwrap();
        assert!(args.contains("--permission-mode\nbypassPermissions\n"));
        assert!(args.contains("--dangerously-skip-permissions\n"));
        assert!(args.contains("--safe-mode\n"));
        assert!(args.contains("--strict-mcp-config\n"));
        assert!(args.contains("--setting-sources\n\n"));
        assert!(!args.contains("--restricted\n"));
        assert!(!args.contains("--permission-prompt-tool\n"));
        let mut settings = manager.settings();
        settings.permission_mode = PermissionMode::Ask;
        manager.configure(settings).unwrap();
        manager.start("claude", "Ask fixture", None).unwrap();
        wait_status(&manager, "complete").await;
        let args = fs::read_to_string(dir.path().join("claude.args")).unwrap();
        assert!(args.contains("--permission-mode\nmanual\n"));
        assert!(args.contains("--restricted\n"));
        assert!(args.contains("--permission-prompt-tool\nstdio\n"));
        assert!(args.contains("--setting-sources\n\n"));
        assert!(!args.contains("bypassPermissions"));
        assert!(!args.contains("--dangerously-skip-permissions"));
        assert!(!args.contains("--resume\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_job_stops_and_does_not_stop_other_processes() {
        let (_dir, manager) = fixture(
            "codex",
            r#"
while IFS= read -r frame; do
  case "$frame" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}' ;;
    *'"method":"turn/start"'*) printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn"}}}' ;;
  esac
done
"#,
        );
        let mut independent = Command::new("/bin/sleep")
            .arg("20")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        manager.start("codex", "Wait", None).unwrap();
        wait_status(&manager, "running").await;
        manager.cancel().unwrap();
        wait_status(&manager, "cancelled").await;
        assert!(independent.try_wait().unwrap().is_none());
        independent.kill().await.unwrap();
        assert!(manager.snapshot().approvals.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_job_guard_terminates_its_process_group() {
        use std::os::unix::process::{CommandExt, ExitStatusExt};
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 20 & wait"]).kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let mut child = command.spawn().unwrap();
        let guard = ProcessGroupGuard::new(&child);
        drop(guard);
        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_auth_probe_reaps_background_descendants() {
        let (dir, _manager) = fixture(
            "claude",
            r#"
sleep 20 </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > "$1"
printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai"}'
"#,
        );
        let marker = dir.path().join("probe-child.pid");
        let (status, _) = auth_probe(
            &dir.path().join("claude"),
            &[marker.to_str().unwrap()],
            "claude",
        )
        .await;
        assert_eq!(status, "signed_in");
        let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
        let stopped = tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if stopped.is_err() {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        assert!(stopped.is_ok(), "Auth probe leaked its background process");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provider_failure_is_error_even_after_successful_handshake() {
        let (_dir, manager) = fixture(
            "codex",
            r#"
while IFS= read -r frame; do
  case "$frame" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}' ;;
    *'"method":"turn/start"'*) printf '%s\n' '{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"Usage limit reached"}}}}' ;;
  esac
done
"#,
        );
        manager.start("codex", "Test", None).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while manager.snapshot().status != "error" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            manager.snapshot().error.as_deref(),
            Some("Usage limit reached")
        );
        assert!(manager.state.lock().unwrap().control.is_none());
    }
}
