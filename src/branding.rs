use std::path::{Path, PathBuf};

// Continue using an existing Relay installation's recovery and preferences.
// Fresh installations use Nimlo's directory; no data is moved or overwritten.
pub fn state_root(home: &Path) -> PathBuf {
    let current = home.join(".nimlo");
    let legacy = home.join(".relay-editor");
    if !current.exists() && legacy.is_dir() {
        legacy
    } else {
        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_recovery_is_preserved_and_new_installations_use_nimlo() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(state_root(home.path()), home.path().join(".nimlo"));
        let legacy = home.path().join(".relay-editor");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("ai-settings.json"), "existing preferences").unwrap();
        assert_eq!(state_root(home.path()), legacy);
        let current = home.path().join(".nimlo");
        std::fs::create_dir(&current).unwrap();
        assert_eq!(state_root(home.path()), current);
        assert_eq!(
            std::fs::read_to_string(legacy.join("ai-settings.json")).unwrap(),
            "existing preferences"
        );
    }
}
