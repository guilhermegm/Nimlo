//! Explicit local development assets. Production always uses embedded bytes.
use std::{io::Read, path::Path};

pub const MAX_ASSET: u64 = 1024 * 1024;

pub fn read_asset(directory: &Path, name: &str) -> std::io::Result<Vec<u8>> {
    if !matches!(
        name,
        "index.html"
            | "app.js"
            | "editor.js"
            | "style.css"
            | "favicon.png"
            | "apple-touch-icon.png"
            | "logo.png"
    ) {
        return Err(std::io::Error::other("Unknown development asset"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(directory.join(name))?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(
            "Development assets must be regular files",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_ASSET + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_ASSET {
        return Err(std::io::Error::other("Development asset exceeds 1 MiB"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_regular_known_assets_are_read() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("app.js"), "development").unwrap();
        assert_eq!(read_asset(root.path(), "app.js").unwrap(), b"development");
        assert!(read_asset(root.path(), "../app.js").is_err());
        assert!(read_asset(root.path(), "secret.txt").is_err());
        std::fs::create_dir(root.path().join("index.html")).unwrap();
        assert!(read_asset(root.path(), "index.html").is_err());
        std::fs::write(
            root.path().join("style.css"),
            vec![b'a'; MAX_ASSET as usize + 1],
        )
        .unwrap();
        assert!(read_asset(root.path(), "style.css").is_err());
        #[cfg(unix)]
        {
            std::fs::remove_file(root.path().join("app.js")).unwrap();
            std::os::unix::fs::symlink("style.css", root.path().join("app.js")).unwrap();
            assert!(read_asset(root.path(), "app.js").is_err());
        }
    }
}
