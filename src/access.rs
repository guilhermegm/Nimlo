//! Device capabilities and an optional pairing password. Password hashing is
//! deliberately synchronous: callers run updates and verification on their
//! blocking worker, and no password or Argon2 allocation is retained afterward.
use crate::protocol::{Error, Result};
use argon2::{
    Argon2, Params,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const MAX_RECORD: u64 = 4096;
const MAX_HASH: usize = 512;
const MAX_PASSWORD_BYTES: usize = 512;
const LOAD_ERROR: &str = "Device access settings could not be read safely. Device access is disabled until you save new settings.";

#[derive(Copy, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevicePermissions {
    pub edit_files: bool,
    pub terminal: bool,
    pub ai: bool,
}

impl DevicePermissions {
    pub const FULL: Self = Self {
        edit_files: true,
        terminal: true,
        ai: true,
    };
    pub const NONE: Self = Self {
        edit_files: false,
        terminal: false,
        ai: false,
    };

    pub fn intersect(self, other: Self) -> Self {
        Self {
            edit_files: self.edit_files && other.edit_files,
            terminal: self.terminal && other.terminal,
            ai: self.ai && other.ai,
        }
    }
}

impl Default for DevicePermissions {
    fn default() -> Self {
        Self::FULL
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessSettings {
    pub allow_devices: bool,
    pub permissions: DevicePermissions,
}

impl Default for AccessSettings {
    fn default() -> Self {
        Self {
            allow_devices: true,
            permissions: DevicePermissions::FULL,
        }
    }
}

#[derive(Clone, Default)]
pub struct AccessPolicy {
    pub settings: AccessSettings,
    password_hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    settings: AccessSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
}

impl AccessPolicy {
    pub fn load(path: Option<&Path>) -> Self {
        let Some(path) = path else {
            return Self::default();
        };
        match read_record(path) {
            Ok(None) => Self::default(),
            Ok(Some(record)) => Self {
                settings: record.settings,
                password_hash: record.password_hash,
                error: None,
            },
            Err(_) => Self {
                settings: AccessSettings {
                    allow_devices: false,
                    permissions: DevicePermissions::NONE,
                },
                password_hash: None,
                error: Some(LOAD_ERROR.to_owned()),
            },
        }
    }

    /// Safe for snapshots and logs: never contains a hash, salt or password.
    pub fn public_view(&self) -> Value {
        let mut view = json!({
            "allowDevices": self.settings.allow_devices,
            "permissions": self.settings.permissions,
            "passwordSet": self.password_hash.is_some(),
        });
        if let Some(error) = &self.error {
            view["error"] = json!(error);
        }
        view
    }

    pub fn verify_password(&self, password: &str) -> bool {
        if self.error.is_some() || password.len() > MAX_PASSWORD_BYTES {
            return false;
        }
        let Some(encoded) = &self.password_hash else {
            return true;
        };
        let Ok(parsed) = bounded_hash(encoded) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    /// Return the new policy only after its private record has been saved.
    /// `None` keeps the password; an empty string removes it.
    pub fn update(
        &self,
        settings: AccessSettings,
        password: Option<&str>,
        path: Option<&Path>,
    ) -> Result<Self> {
        let password_hash = match password {
            None => self.password_hash.clone(),
            Some("") => None,
            Some(password) => {
                if password.len() > MAX_PASSWORD_BYTES
                    || !(8..=128).contains(&password.chars().count())
                {
                    return Err(Error::new(
                        "invalid_password",
                        "Use a password with 8 to 128 characters (at most 512 UTF-8 bytes).",
                    ));
                }
                // Use the app's cryptographic thread RNG for a fresh 128-bit salt.
                let salt_bytes: [u8; 16] = rand::random();
                let salt = SaltString::encode_b64(&salt_bytes).map_err(|_| {
                    Error::new("password_hash", "Could not secure the pairing password.")
                })?;
                Some(
                    Argon2::default()
                        .hash_password(password.as_bytes(), &salt)
                        .map_err(|_| {
                            Error::new("password_hash", "Could not secure the pairing password.")
                        })?
                        .to_string(),
                )
            }
        };
        let next = Self {
            settings,
            password_hash,
            error: None,
        };
        if let Some(path) = path {
            save_record(
                path,
                &Record {
                    version: 1,
                    settings: next.settings.clone(),
                    password_hash: next.password_hash.clone(),
                },
            )
            .map_err(|_| {
                Error::new(
                    "access_persistence",
                    "Could not save device access settings safely. Your previous settings are still active.",
                )
            })?;
        }
        Ok(next)
    }
}

/// Verification uses parameters from the PHC record. Accept only this app's
/// fixed Argon2id profile, so an edited record cannot request a huge allocation,
/// weaken the password hash, or switch algorithms.
fn bounded_hash(encoded: &str) -> std::io::Result<PasswordHash<'_>> {
    if encoded.len() > MAX_HASH {
        return Err(invalid_record());
    }
    let parsed = PasswordHash::new(encoded).map_err(|_| invalid_record())?;
    let params = Params::try_from(&parsed).map_err(|_| invalid_record())?;
    let defaults = Params::default();
    let mut salt_bytes = [0u8; 64];
    let salt_len = parsed
        .salt
        .ok_or_else(invalid_record)?
        .decode_b64(&mut salt_bytes)
        .map_err(|_| invalid_record())?
        .len();
    if parsed.algorithm.as_str() != "argon2id"
        || parsed.version != Some(19)
        || params.m_cost() != defaults.m_cost()
        || params.t_cost() != defaults.t_cost()
        || params.p_cost() != defaults.p_cost()
        || !params.keyid().is_empty()
        || !params.data().is_empty()
        || parsed.params.iter().count() != 3
        || parsed.hash.as_ref().map(|hash| hash.as_bytes().len()) != Some(32)
        || salt_len != 16
    {
        return Err(invalid_record());
    }
    Ok(parsed)
}

fn invalid_record() -> std::io::Error {
    std::io::Error::other("Invalid or insecure device access settings")
}

fn state_parent(path: &Path) -> std::io::Result<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(invalid_record)
}

fn check_private_metadata(metadata: &fs::Metadata, directory: bool) -> std::io::Result<()> {
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(invalid_record());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let expected = if directory { 0o700 } else { 0o600 };
        if metadata.mode() & 0o777 != expected || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(invalid_record());
        }
    }
    Ok(())
}

fn read_record(path: &Path) -> std::io::Result<Option<Record>> {
    // Older installations have no access record and may use a broader state
    // directory mode. Preserve their established defaults until settings are
    // first saved; an existing record must satisfy every security check below.
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let parent = state_parent(path)?;
    match fs::symlink_metadata(parent) {
        Ok(metadata) => check_private_metadata(&metadata, true)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut options = fs::OpenOptions::new();
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
    let metadata = file.metadata()?;
    check_private_metadata(&metadata, false)?;
    if metadata.len() > MAX_RECORD {
        return Err(invalid_record());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RECORD as usize {
        return Err(invalid_record());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| invalid_record())?;
    if record.version != 1 {
        return Err(invalid_record());
    }
    if let Some(encoded) = &record.password_hash {
        bounded_hash(encoded)?;
    }
    Ok(Some(record))
}

fn save_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(record)?;
    if bytes.len() + 1 > MAX_RECORD as usize {
        return Err(invalid_record());
    }
    let parent = state_parent(path)?;
    if let Ok(metadata) = fs::symlink_metadata(parent) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid_record());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } {
                return Err(invalid_record());
            }
        }
    }
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    if fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_file()) {
        return Err(invalid_record());
    }
    let temporary = parent.join(format!(".access-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restricted() -> AccessSettings {
        AccessSettings {
            allow_devices: true,
            permissions: DevicePermissions {
                edit_files: false,
                terminal: true,
                ai: false,
            },
        }
    }

    #[test]
    fn password_is_verified_and_only_a_private_hash_is_persisted() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("access.json");
        let password = "nimlo-test-secret";
        let policy = AccessPolicy::default()
            .update(restricted(), Some(password), Some(&path))
            .unwrap();
        assert!(policy.verify_password(password));
        assert!(!policy.verify_password("incorrect-password"));
        assert!(!policy.verify_password(""));
        let stored = fs::read_to_string(&path).unwrap();
        assert!(!stored.contains(password));
        assert!(stored.contains("$argon2id$v=19$"));
        let view = policy.public_view();
        assert_eq!(view["passwordSet"], true);
        assert!(view.get("passwordHash").is_none());
        assert!(!view.to_string().contains("argon2"));
        let loaded = AccessPolicy::load(Some(&path));
        assert!(loaded.error.is_none());
        assert!(loaded.verify_password(password));
        assert_eq!(loaded.settings.permissions, restricted().permissions);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(state.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn password_updates_keep_clear_validate_and_randomize_the_hash() {
        let policy = AccessPolicy::default()
            .update(restricted(), Some("long-enough-password"), None)
            .unwrap();
        let kept = policy
            .update(AccessSettings::default(), None, None)
            .unwrap();
        assert!(kept.verify_password("long-enough-password"));
        assert_eq!(kept.password_hash, policy.password_hash);
        let cleared = kept.update(restricted(), Some(""), None).unwrap();
        assert_eq!(cleared.public_view()["passwordSet"], false);
        assert!(cleared.verify_password(""));
        assert!(policy.update(restricted(), Some("short"), None).is_err());
        assert!(
            policy
                .update(restricted(), Some(&"a".repeat(129)), None)
                .is_err()
        );
        assert!(
            policy
                .update(restricted(), Some(&"🦊".repeat(129)), None)
                .is_err()
        );
        let second = policy
            .update(restricted(), Some("long-enough-password"), None)
            .unwrap();
        assert_ne!(second.password_hash, policy.password_hash);
    }

    #[test]
    fn missing_state_is_default_and_malformed_or_large_state_fails_closed() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("access.json");
        assert!(AccessPolicy::load(None).settings.allow_devices);
        assert!(AccessPolicy::load(Some(&path)).settings.allow_devices);
        AccessPolicy::default()
            .update(restricted(), None, Some(&path))
            .unwrap();
        for bytes in [b"not-json".to_vec(), vec![b' '; MAX_RECORD as usize + 1]] {
            fs::write(&path, bytes).unwrap();
            let loaded = AccessPolicy::load(Some(&path));
            assert!(!loaded.settings.allow_devices);
            assert_eq!(loaded.settings.permissions, DevicePermissions::NONE);
            assert!(!loaded.verify_password(""));
            assert_eq!(loaded.public_view()["error"], LOAD_ERROR);
        }
    }

    #[test]
    fn attacker_selected_hash_profiles_are_rejected_without_hashing() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("access.json");
        let policy = AccessPolicy::default()
            .update(restricted(), Some("long-enough-password"), Some(&path))
            .unwrap();
        let encoded = policy.password_hash.unwrap();
        assert!(bounded_hash(&encoded).is_ok());
        for tampered in [
            encoded.replace("argon2id", "argon2i"),
            encoded.replace("v=19", "v=16"),
            encoded.replace("m=19456", "m=4294967295"),
            encoded.replace("m=19456", "m=8"),
            encoded.replace("t=2", "t=4294967295"),
            encoded.replace("p=1", "p=255"),
        ] {
            assert!(bounded_hash(&tampered).is_err());
            let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            record["passwordHash"] = json!(tampered);
            fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            let loaded = AccessPolicy::load(Some(&path));
            assert!(loaded.error.is_some());
            assert!(!loaded.settings.allow_devices);
        }
    }

    #[test]
    fn persistence_failure_leaves_the_original_policy_and_file_unchanged() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("access.json");
        let original = AccessPolicy::default()
            .update(restricted(), None, Some(&path))
            .unwrap();
        let bytes = fs::read(&path).unwrap();
        let invalid = path.join("impossible.json");
        assert!(
            original
                .update(AccessSettings::default(), None, Some(&invalid))
                .is_err()
        );
        assert_eq!(original.settings.permissions, restricted().permissions);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_public_state_are_rejected_and_original_state_survives() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("access.json");
        let policy = AccessPolicy::default()
            .update(restricted(), None, Some(&path))
            .unwrap();
        let bytes = fs::read(&path).unwrap();
        let link = state.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert!(AccessPolicy::load(Some(&link)).error.is_some());
        assert!(
            policy
                .update(AccessSettings::default(), None, Some(&link))
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let directory_link = state.path().join("state-link");
        symlink(state.path(), &directory_link).unwrap();
        assert!(
            AccessPolicy::load(Some(&directory_link.join("access.json")))
                .error
                .is_some()
        );
        assert!(
            policy
                .update(
                    restricted(),
                    None,
                    Some(&directory_link.join("access.json"))
                )
                .is_err()
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(AccessPolicy::load(Some(&path)).error.is_some());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(state.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(AccessPolicy::load(Some(&path)).error.is_some());
        let missing = state.path().join("not-yet-configured.json");
        let unconfigured = AccessPolicy::load(Some(&missing));
        assert!(unconfigured.error.is_none());
        assert!(unconfigured.settings.allow_devices);
        assert_eq!(unconfigured.settings.permissions, DevicePermissions::FULL);
    }

    #[test]
    fn capability_intersection_never_grants_a_missing_permission() {
        let permissions = restricted().permissions;
        assert_eq!(permissions.intersect(DevicePermissions::FULL), permissions);
        assert_eq!(
            permissions.intersect(DevicePermissions::NONE),
            DevicePermissions::NONE
        );
    }
}
