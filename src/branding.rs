use std::path::{Path, PathBuf};

// Keep Neovim workspace recovery separate from other editor state.
pub fn state_root(home: &Path) -> PathBuf {
    home.join(".nimlo-neovim")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_root_keeps_other_editors_recovery_separate() {
        let home = tempfile::tempdir().unwrap();
        for directory in [".nimlo", ".relay-editor"] {
            std::fs::create_dir(home.path().join(directory)).unwrap();
        }
        assert_eq!(state_root(home.path()), home.path().join(".nimlo-neovim"));
    }
}
