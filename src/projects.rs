//! Bounded metadata for attached folders. No document, process or credential is
//! persisted here; each workspace owns its existing independent recovery file.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_PROJECTS: usize = 32;
const MAX_RECORD: u64 = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    roots: Vec<PathBuf>,
}

pub fn load(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_RECORD {
        return Err(std::io::Error::other(
            "Attached projects must be a bounded regular file",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD + 1).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RECORD as usize {
        return Err(std::io::Error::other("Attached projects file is too large"));
    }
    let record: Record = serde_json::from_slice(&bytes)?;
    if record.version != 1
        || record.roots.len() > MAX_PROJECTS
        || record
            .roots
            .iter()
            .any(|root| !root.is_absolute() || root.as_os_str().len() > 4096)
    {
        return Err(std::io::Error::other("Attached projects file is invalid"));
    }
    Ok(record.roots)
}

pub fn save(path: &Path, roots: Vec<PathBuf>) -> std::io::Result<()> {
    if roots.len() > MAX_PROJECTS
        || roots
            .iter()
            .any(|root| !root.is_absolute() || root.as_os_str().len() > 4096)
    {
        return Err(std::io::Error::other(
            "Too many or invalid attached projects",
        ));
    }
    let bytes = serde_json::to_vec(&Record { version: 1, roots })?;
    if bytes.len() + 1 > MAX_RECORD as usize {
        return Err(std::io::Error::other(
            "Attached projects record is too large",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Missing project state directory"))?;
    if fs::symlink_metadata(parent).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(std::io::Error::other(
            "Project state directory must not be a symlink",
        ));
    }
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    if fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_file() || meta.file_type().is_symlink())
    {
        return Err(std::io::Error::other(
            "Attached projects must be a regular file",
        ));
    }
    let temporary = parent.join(format!(".projects-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
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
    #[test]
    fn bounded_private_metadata_roundtrips_and_rejects_invalid_records() {
        let state = tempfile::tempdir().unwrap();
        let path = state.path().join("projects.json");
        let roots = vec![state.path().join("one"), state.path().join("two")];
        save(&path, roots.clone()).unwrap();
        assert_eq!(load(&path).unwrap(), roots);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::write(&path, br#"{"version":1,"roots":["relative"]}"#).unwrap();
        assert!(load(&path).is_err());
        fs::write(&path, vec![b' '; MAX_RECORD as usize + 1]).unwrap();
        assert!(load(&path).is_err());
        assert!(save(&path, vec![state.path().to_owned(); MAX_PROJECTS + 1]).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn metadata_refuses_symlink_reads_and_writes() {
        let state = tempfile::tempdir().unwrap();
        let source = state.path().join("source.json");
        save(&source, vec![state.path().to_owned()]).unwrap();
        let link = state.path().join("link.json");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(load(&link).is_err());
        assert!(save(&link, vec![state.path().to_owned()]).is_err());
        assert_eq!(load(&source).unwrap().len(), 1);
    }
}
