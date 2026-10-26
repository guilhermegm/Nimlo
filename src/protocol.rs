use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    ClaimControl,
    RequestControl,
    ReleaseControl {
        generation: u64,
    },
    HandoffControl {
        generation: u64,
        #[serde(rename = "targetClientId")]
        target_client_id: String,
    },
    OpenProject {
        path: String,
        generation: u64,
    },
    AddProject {
        path: String,
        generation: u64,
    },
    SelectProject {
        #[serde(rename = "targetProjectId")]
        target_project_id: String,
        generation: u64,
    },
    RemoveProject {
        #[serde(rename = "targetProjectId")]
        target_project_id: String,
        generation: u64,
    },
    BrowseProject {
        generation: u64,
    },
    ListFiles {
        #[serde(default)]
        directory: String,
    },
    ListProjectFiles {
        #[serde(rename = "targetProjectId")]
        target_project_id: String,
        #[serde(default)]
        directory: String,
        generation: u64,
    },
    SearchProjectFiles {
        #[serde(rename = "targetProjectId")]
        target_project_id: String,
        query: String,
        #[serde(default)]
        cursor: Option<crate::workspace::SearchCursor>,
        generation: u64,
    },
    OpenFile {
        path: String,
        #[serde(default)]
        generation: Option<u64>,
    },
    SelectFile {
        path: String,
        generation: u64,
    },
    CreateFile {
        path: String,
        #[serde(default)]
        content: String,
        generation: u64,
    },
    EditFile {
        path: String,
        #[serde(rename = "baseRevision")]
        base_revision: u64,
        content: String,
        generation: u64,
    },
    PatchFile {
        path: String,
        #[serde(rename = "baseRevision")]
        base_revision: u64,
        start: u64,
        #[serde(rename = "deleteCount")]
        delete_count: u64,
        insert: String,
        generation: u64,
    },
    FileSync {
        path: String,
        generation: u64,
    },
    UndoFile {
        path: String,
        revision: u64,
        generation: u64,
    },
    RedoFile {
        path: String,
        revision: u64,
        generation: u64,
    },
    SaveFile {
        path: String,
        revision: u64,
        generation: u64,
    },
    CloseFile {
        path: String,
        #[serde(default)]
        discard: bool,
        #[serde(default)]
        revision: Option<u64>,
        generation: u64,
    },
    ResolveConflict {
        path: String,
        revision: u64,
        #[serde(rename = "diskRevision")]
        disk_revision: String,
        resolution: String,
        generation: u64,
    },
    PairCreate {
        generation: u64,
        #[serde(default)]
        origin: Option<String>,
    },
    SessionAccessSet {
        generation: u64,
        settings: crate::access::AccessSettings,
        #[serde(default)]
        password: Option<String>,
    },
    DevicePermissionsSet {
        generation: u64,
        #[serde(rename = "targetClientId")]
        target_client_id: String,
        permissions: crate::access::DevicePermissions,
    },
    RevokeDevice {
        generation: u64,
        #[serde(rename = "targetClientId")]
        target_client_id: String,
    },
    RevokeAllDevices {
        generation: u64,
    },
    InternetStart {
        generation: u64,
    },
    InternetStop {
        generation: u64,
    },
    TerminalStart {
        generation: u64,
    },
    TerminalInput {
        data: String,
        generation: u64,
    },
    TerminalResize {
        cols: u16,
        rows: u16,
        generation: u64,
    },
    TerminalStop {
        generation: u64,
    },
    TerminalHistory {
        #[serde(default = "history_limit")]
        limit: usize,
    },
    AiStatus,
    AiOpenFile {
        target: String,
    },
    AiSettingsGet,
    AiSettingsSet {
        settings: crate::ai::AiSettings,
        generation: u64,
    },
    AiAuthRefresh {
        generation: u64,
    },
    AiStart {
        provider: String,
        prompt: String,
        #[serde(default)]
        path: Option<String>,
        generation: u64,
    },
    AiApprove {
        id: String,
        choice: String,
        generation: u64,
    },
    AiCancel {
        generation: u64,
    },
    Ping,
}

impl Command {
    pub fn generation(&self) -> Option<u64> {
        match self {
            Self::OpenFile { generation, .. } => *generation,
            Self::ReleaseControl { generation }
            | Self::HandoffControl { generation, .. }
            | Self::OpenProject { generation, .. }
            | Self::AddProject { generation, .. }
            | Self::SelectProject { generation, .. }
            | Self::RemoveProject { generation, .. }
            | Self::ListProjectFiles { generation, .. }
            | Self::SearchProjectFiles { generation, .. }
            | Self::BrowseProject { generation }
            | Self::EditFile { generation, .. }
            | Self::PatchFile { generation, .. }
            | Self::FileSync { generation, .. }
            | Self::UndoFile { generation, .. }
            | Self::SelectFile { generation, .. }
            | Self::CreateFile { generation, .. }
            | Self::RedoFile { generation, .. }
            | Self::SaveFile { generation, .. }
            | Self::CloseFile { generation, .. }
            | Self::ResolveConflict { generation, .. }
            | Self::PairCreate { generation, .. }
            | Self::SessionAccessSet { generation, .. }
            | Self::DevicePermissionsSet { generation, .. }
            | Self::RevokeDevice { generation, .. }
            | Self::RevokeAllDevices { generation }
            | Self::InternetStart { generation }
            | Self::InternetStop { generation }
            | Self::TerminalStart { generation }
            | Self::TerminalInput { generation, .. }
            | Self::TerminalResize { generation, .. }
            | Self::TerminalStop { generation }
            | Self::AiStart { generation, .. }
            | Self::AiApprove { generation, .. }
            | Self::AiCancel { generation } => Some(*generation),
            Self::AiSettingsSet { generation, .. } | Self::AiAuthRefresh { generation } => {
                Some(*generation)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct Envelope {
    #[serde(flatten)]
    pub command: Command,
    #[serde(rename = "requestId", default)]
    pub request_id: Option<String>,
    #[serde(rename = "projectId", default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::new("io", error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

fn history_limit() -> usize {
    200
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_commands_distinguish_source_scope_from_target_and_require_generation() {
        for command in [
            "select_project",
            "remove_project",
            "list_project_files",
            "search_project_files",
        ] {
            assert!(
                serde_json::from_value::<Envelope>(
                    serde_json::json!({"type":command,"targetProjectId":"target"})
                )
                .is_err()
            );
            let envelope: Envelope = serde_json::from_value(serde_json::json!({"type":command,"projectId":"current","targetProjectId":"target","query":"name","generation":8})).unwrap();
            assert_eq!(envelope.project_id.as_deref(), Some("current"));
            assert_eq!(envelope.command.generation(), Some(8));
        }
        let legacy: Envelope = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert!(legacy.project_id.is_none());
    }

    #[test]
    fn internet_commands_require_a_project_generation() {
        for command in ["internet_start", "internet_stop"] {
            assert!(
                serde_json::from_value::<Command>(serde_json::json!({"type":command})).is_err()
            );
            let parsed: Command =
                serde_json::from_value(serde_json::json!({"type":command,"generation":7})).unwrap();
            assert_eq!(parsed.generation(), Some(7));
        }
    }

    #[test]
    fn pairing_origin_is_optional_and_revocation_requires_a_generation() {
        let legacy: Command =
            serde_json::from_str(r#"{"type":"pair_create","generation":3}"#).unwrap();
        assert!(matches!(legacy, Command::PairCreate { origin: None, .. }));
        let current: Command = serde_json::from_str(
            r#"{"type":"pair_create","generation":3,"origin":"https://nimlo.example"}"#,
        )
        .unwrap();
        assert!(matches!(
            current,
            Command::PairCreate {
                origin: Some(_),
                ..
            }
        ));
        for command in ["revoke_device", "revoke_all_devices"] {
            assert!(
                serde_json::from_value::<Command>(
                    serde_json::json!({"type": command,"targetClientId":"device123"})
                )
                .is_err()
            );
            let parsed: Command = serde_json::from_value(
                serde_json::json!({"type":command,"targetClientId":"device123","generation":3}),
            )
            .unwrap();
            assert_eq!(parsed.generation(), Some(3));
        }
    }

    #[test]
    fn file_reads_accept_legacy_requests_and_fence_explicit_project_generations() {
        let legacy: Command =
            serde_json::from_str(r#"{"type":"open_file","path":"file.rs"}"#).unwrap();
        assert_eq!(legacy.generation(), None);
        let current: Command =
            serde_json::from_str(r#"{"type":"open_file","path":"file.rs","generation":4}"#)
                .unwrap();
        assert_eq!(current.generation(), Some(4));
    }

    #[test]
    fn close_requests_capture_file_revision_without_breaking_clean_legacy_close() {
        let current: Command = serde_json::from_str(
            r#"{"type":"close_file","path":"file.rs","discard":true,"revision":42,"generation":4}"#,
        )
        .unwrap();
        assert!(matches!(
            current,
            Command::CloseFile {
                revision: Some(42),
                discard: true,
                ..
            }
        ));
        let legacy: Command =
            serde_json::from_str(r#"{"type":"close_file","path":"file.rs","generation":4}"#)
                .unwrap();
        assert!(matches!(
            legacy,
            Command::CloseFile {
                revision: None,
                discard: false,
                ..
            }
        ));
    }
}
