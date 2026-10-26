use crate::protocol::{Error, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufWriter, Read, Write},
    ops::Deref,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::SystemTime,
};

pub const MAX_FILE: usize = 1024 * 1024;
pub const MAX_OPEN: usize = 8;
pub const MAX_BUFFERS: usize = 8 * MAX_FILE;
pub const MAX_HISTORY: usize = 2 * MAX_FILE;
pub const MAX_RECENT_FILES: usize = 32;
const MAX_RECENT_PATH_BYTES: usize = 16 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_SEARCH_RESULTS: usize = 80;
const MAX_SEARCH_ENTRIES: usize = 20_000;
const MAX_SEARCH_DEPTH: usize = 32;
// Includes worst-case JSON escaping for 8 MiB buffers plus 8 MiB disk conflicts.
const MAX_RECOVERY: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_RECORD: u64 = 16 * 1024 * 1024;

/// Immutable source text shared by a document, history, and rollback snapshots.
/// Moving an incoming String here preserves its allocation; cloning a snapshot
/// only retains the same bytes. Serialization stays a plain JSON string.
#[derive(Debug, Clone)]
pub struct Text(Arc<String>);

impl From<String> for Text {
    fn from(text: String) -> Self {
        Self(Arc::new(text))
    }
}

impl Deref for Text {
    type Target = str;

    fn deref(&self) -> &str {
        self.0.as_str()
    }
}

impl AsRef<str> for Text {
    fn as_ref(&self) -> &str {
        self
    }
}

impl<T: AsRef<str> + ?Sized> PartialEq<T> for Text {
    fn eq(&self, other: &T) -> bool {
        self.as_ref() == other.as_ref()
    }
}

impl Eq for Text {}

impl Serialize for Text {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self)
    }
}

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::from)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub disk_content: Option<Text>,
    pub disk_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub path: String,
    pub content: Text,
    pub revision: u64,
    pub dirty: bool,
    pub conflict: Option<Conflict>,
    #[serde(skip)]
    pub undo: VecDeque<Text>,
    #[serde(skip)]
    pub redo: VecDeque<Text>,
    #[serde(skip_serializing)]
    pub saved_revision: String,
    #[serde(skip)]
    disk_observation: Option<DiskObservation>,
}

// Session-only history for unloaded saved files. The current source buffer is
// read from disk again; a fingerprint prevents restoring history onto new text.
#[derive(Clone)]
struct SavedHistory {
    saved_revision: String,
    undo: VecDeque<Text>,
    redo: VecDeque<Text>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiskObservation {
    Present {
        length: u64,
        modified: Option<SystemTime>,
        #[cfg(unix)]
        inode: u64,
        #[cfg(unix)]
        device: u64,
        #[cfg(unix)]
        changed: i64,
        #[cfg(unix)]
        changed_nanos: i64,
    },
    Unavailable(&'static str),
}

impl Document {
    fn view(&self) -> Self {
        Self {
            path: self.path.clone(),
            content: self.content.clone(),
            revision: self.revision,
            dirty: self.dirty,
            conflict: self.conflict.clone(),
            saved_revision: self.saved_revision.clone(),
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            disk_observation: self.disk_observation.clone(),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub size: u64,
}

#[derive(Deserialize)]
struct Recovery {
    version: u8,
    workspace: PathBuf,
    #[serde(default)]
    active_path: Option<String>,
    #[serde(default)]
    recent_paths: Vec<String>,
    #[serde(default)]
    revision_clock: u64,
    documents: Vec<Document>,
}

#[derive(Deserialize)]
struct RecoveryOwner {
    workspace: PathBuf,
}

#[derive(Deserialize)]
struct RecoveryVersion {
    version: u8,
}

#[derive(Serialize, Deserialize)]
struct RecoveryIntent {
    previous: bool,
}

#[derive(Serialize, Deserialize)]
struct RecoveryManifest {
    version: u8,
    workspace: PathBuf,
    active_path: Option<String>,
    #[serde(default)]
    recent_paths: Vec<String>,
    #[serde(default)]
    revision_clock: u64,
    documents: Vec<RecoveryReference>,
    // Also read as RecoveryIntent when the synced manifest is linked as the
    // transaction marker. Older v2 manifests did not have this field.
    #[serde(default)]
    previous: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct RecoveryReference {
    path: String,
    record: String,
}

#[derive(Clone, PartialEq, Eq)]
struct CheckpointSignature {
    revision: u64,
    dirty: bool,
    saved_revision: String,
    conflict_revision: Option<String>,
}

impl CheckpointSignature {
    fn of(document: &Document) -> Self {
        Self {
            revision: document.revision,
            dirty: document.dirty,
            saved_revision: document.saved_revision.clone(),
            conflict_revision: document.conflict.as_ref().map(|c| c.disk_revision.clone()),
        }
    }
}

#[derive(Clone)]
struct Checkpoint {
    signature: CheckpointSignature,
    reference: RecoveryReference,
    observation: DiskObservation,
}

struct HashWriter<W> {
    inner: W,
    hash: Sha256,
}

impl<W: Write> Write for HashWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let count = self.inner.write(bytes)?;
        self.hash.update(&bytes[..count]);
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

#[derive(Serialize)]
struct RecoveryDocument<'a> {
    path: &'a str,
    content: &'a str,
    revision: u64,
    dirty: bool,
    conflict: &'a Option<Conflict>,
    saved_revision: &'a str,
}

pub struct Workspace {
    pub root: PathBuf,
    #[cfg(unix)]
    root_handle: Option<File>,
    state_dir: PathBuf,
    documents: BTreeMap<String, Document>,
    saved_histories: BTreeMap<String, SavedHistory>,
    recent_paths: Vec<String>,
    revision_clock: u64,
    max_open: usize,
    max_history: usize,
    pub active_path: Option<String>,
    checkpoints: Mutex<BTreeMap<String, Checkpoint>>,
    recovery_poisoned: AtomicBool,
    _lock: Option<File>,
    #[cfg(test)]
    disk_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    fail_commit_sync: AtomicBool,
    #[cfg(test)]
    fail_finish_sync: AtomicBool,
    #[cfg(test)]
    fail_prepare: AtomicBool,
}

// Revisions cross a JSON boundary and must remain exact in browser numbers.
const MAX_REVISION: u64 = (1 << 53) - 1;

fn safe_file_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\0', '\\'])
        && !Path::new(path).is_absolute()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn next_revision(clock: &mut u64) -> Result<u64> {
    if *clock >= MAX_REVISION {
        return Err(Error::new(
            "limit",
            "Document revision limit reached; restart the host",
        ));
    }
    *clock += 1;
    Ok(*clock)
}

fn fingerprint(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn metadata_observation(metadata: &fs::Metadata) -> DiskObservation {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    DiskObservation::Present {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        changed: metadata.ctime(),
        #[cfg(unix)]
        changed_nanos: metadata.ctime_nsec(),
    }
}

fn checkpoint_observation(path: &Path) -> Result<DiskObservation> {
    let file = open_regular(path, MAX_RECORD)?;
    Ok(metadata_observation(&file.metadata().map_err(Error::io)?))
}

fn manifest_records(path: &Path) -> Vec<String> {
    let Ok(file) = open_regular(path, MAX_MANIFEST) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    if file.take(MAX_MANIFEST + 1).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let Ok(manifest) = serde_json::from_slice::<RecoveryManifest>(&bytes) else {
        return Vec::new();
    };
    if manifest.version != 2 || manifest.documents.len() > MAX_OPEN {
        return Vec::new();
    }
    manifest
        .documents
        .into_iter()
        .map(|doc| doc.record)
        .filter(|record| record_name(record))
        .collect()
}

fn record_name(name: &str) -> bool {
    name.len() == 78
        && name.starts_with("document-")
        && name.ends_with(".json")
        && name[9..73]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn recovery_id(root: &Path) -> String {
    fingerprint(root.to_string_lossy().as_bytes())[..24].to_owned()
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// An interrupted transaction was never acknowledged. Restore its durable prior
/// manifest before loading documents; retain the interrupted version for review.
fn resume_checkpoint(state_dir: &Path) -> Result<()> {
    let marker = state_dir.join(".recovery-transaction");
    if fs::symlink_metadata(&marker)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let mut bytes = Vec::new();
    open_regular(&marker, MAX_MANIFEST)?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(Error::io)?;
    let intent: RecoveryIntent = serde_json::from_slice(&bytes).map_err(|_| {
        Error::new(
            "recovery_ambiguous",
            "Interrupted recovery marker is invalid; preserve the state directory for review",
        )
    })?;
    let current = state_dir.join("drafts.json");
    let previous = state_dir.join("drafts.previous.json");
    if current.try_exists().map_err(Error::io)? {
        let _verified = open_regular(&current, MAX_RECOVERY)?;
        let interrupted = state_dir.join("drafts.interrupted.json");
        let temp = state_dir.join(format!(".drafts-{:016x}.tmp", rand::random::<u64>()));
        fs::hard_link(&current, &temp).map_err(Error::io)?;
        fs::rename(&temp, interrupted).map_err(Error::io)?;
    }
    if intent.previous {
        let _verified = open_regular(&previous, MAX_RECOVERY)?;
        let temp = state_dir.join(format!(".drafts-{:016x}.tmp", rand::random::<u64>()));
        fs::hard_link(&previous, &temp).map_err(Error::io)?;
        fs::rename(temp, &current).map_err(Error::io)?;
    } else if current.try_exists().map_err(Error::io)? {
        fs::remove_file(&current).map_err(Error::io)?;
    }
    sync_directory(state_dir).map_err(Error::io)?;
    fs::remove_file(marker).map_err(Error::io)?;
    sync_directory(state_dir).map_err(Error::io)
}

fn open_regular(path: &Path, limit: u64) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(Error::io)?;
    let metadata = file.metadata().map_err(Error::io)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(Error::new(
            "recovery",
            "Recovery file is unsafe or too large",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn anchored_open(
    parent: &File,
    name: &str,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> std::io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in path"))?;
    // Every component is opened relative to an already authorized directory handle.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn anchored_rename(parent: &File, old: &str, new: &str) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let old = std::ffi::CString::new(old).unwrap();
    let new = std::ffi::CString::new(new).unwrap();
    let result = unsafe {
        libc::renameat(
            parent.as_raw_fd(),
            old.as_ptr(),
            parent.as_raw_fd(),
            new.as_ptr(),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn anchored_unlink(parent: &File, name: &str) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    let name = std::ffi::CString::new(name).unwrap();
    let result = unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub fn resolve_root(root: &Path, relative: &str, directory: bool) -> Result<PathBuf> {
    let path = Path::new(relative);
    if (relative.len() > 4096
        || path.is_absolute()
        || relative.contains('\\')
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_))))
        && !(relative.is_empty() && directory)
    {
        return Err(Error::new(
            "path",
            "Use a relative workspace path without traversal",
        ));
    }
    let mut current = root.to_owned();
    for component in path.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).map_err(Error::io)?;
        if metadata.file_type().is_symlink() {
            return Err(Error::new("path", "Symlinks are not opened by the editor"));
        }
    }
    let canonical = fs::canonicalize(&current).map_err(Error::io)?;
    if !canonical.starts_with(root) {
        return Err(Error::new("path", "Path is outside the workspace"));
    }
    if canonical.strip_prefix(root).unwrap().to_string_lossy() != relative {
        return Err(Error::new(
            "path",
            "Use the exact relative path without repeated separators",
        ));
    }
    if directory != canonical.is_dir() {
        return Err(Error::new(
            "path",
            if directory {
                "Expected a directory"
            } else {
                "Expected a regular file"
            },
        ));
    }
    if !directory && !canonical.is_file() {
        return Err(Error::new("path", "Only regular files can be opened"));
    }
    Ok(canonical)
}

pub fn list_root(root: &Path, directory: &str) -> Result<Vec<Entry>> {
    let parent = resolve_root(root, directory, true)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(parent)
        .map_err(Error::io)?
        .take(MAX_ENTRIES + 1)
    {
        if entries.len() >= MAX_ENTRIES {
            return Err(Error::new(
                "limit",
                "Directory exceeds the 2000-entry limit; open a smaller directory",
            ));
        }
        let entry = entry.map_err(Error::io)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(Error::io)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if metadata.file_type().is_symlink()
            || name == ".git"
            || name == "node_modules"
            || name == "target"
            || name == ".nimlo"
            || name == ".relay-editor"
        {
            continue;
        }
        if !metadata.is_file() && !metadata.is_dir() {
            continue;
        }
        entries.push(Entry {
            path: if directory.is_empty() {
                name.clone()
            } else {
                format!("{directory}/{name}")
            },
            name,
            directory: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    entries.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
    Ok(entries)
}

// Only directory positions cross search batches; no source text, background
// index, or open directory handles are retained between requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchCursor {
    query: String,
    frames: Vec<SearchFrame>,
    incomplete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchFrame {
    directory: String,
    offset: usize,
}

pub struct SearchPage {
    pub files: Vec<Entry>,
    pub truncated: bool,
    pub cursor: Option<SearchCursor>,
}

/// Scan a bounded batch, then resume where it ended instead of silently losing
/// every file beyond the traversal budget. Closing/changing the picker stops
/// further requests. Each batch retains only its best 80 name matches.
pub fn search_root_page(
    root: &Path,
    query: &str,
    cursor: Option<SearchCursor>,
) -> Result<SearchPage> {
    search_root_bounded(root, query, cursor, MAX_SEARCH_ENTRIES, MAX_SEARCH_DEPTH)
}

fn search_root_bounded(
    root: &Path,
    query: &str,
    cursor: Option<SearchCursor>,
    max_entries: usize,
    max_depth: usize,
) -> Result<SearchPage> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 128 || query.contains(['/', '\\', '\0']) {
        return Err(Error::new(
            "query",
            "Search with a file name of up to 128 characters; use folder paths to browse directly",
        ));
    }
    let query = query.to_lowercase();
    let mut cursor = cursor.unwrap_or_else(|| SearchCursor {
        query: query.clone(),
        frames: vec![SearchFrame {
            directory: String::new(),
            offset: 0,
        }],
        incomplete: false,
    });
    if cursor.query != query
        || cursor.frames.is_empty()
        || cursor.frames.len() > max_depth + 1
        || !cursor.frames[0].directory.is_empty()
        || cursor.frames.iter().any(|frame| {
            frame.directory.len() > 4096
                || frame.directory.contains(['\\', '\0'])
                || Path::new(&frame.directory)
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
        })
        || cursor.frames.windows(2).any(|pair| {
            pair[1].directory.is_empty()
                || pair[1]
                    .directory
                    .rsplit_once('/')
                    .map_or("", |(parent, _)| parent)
                    != pair[0].directory
        })
    {
        return Err(Error::new("query", "Restart the file search"));
    }
    struct Frame {
        position: SearchFrame,
        entries: fs::ReadDir,
    }
    let mut stack = Vec::new();
    for position in cursor.frames {
        // Revalidate all components when resuming, including symlink swaps.
        let entries = resolve_root(root, &position.directory, true)
            .and_then(|parent| fs::read_dir(parent).map_err(Error::io));
        match entries {
            Ok(mut entries) => {
                if position.offset > 0 {
                    entries.nth(position.offset - 1);
                }
                stack.push(Frame { entries, position });
            }
            Err(error) if stack.is_empty() => return Err(error),
            Err(_) => {
                cursor.incomplete = true;
                break;
            }
        }
    }
    let mut files: Vec<Entry> = Vec::new();
    let mut visited = 0;
    let mut overflow = false;
    let compare = |a: &Entry, b: &Entry| {
        b.name
            .to_lowercase()
            .starts_with(&query)
            .cmp(&a.name.to_lowercase().starts_with(&query))
            .then(b.directory.cmp(&a.directory))
            .then(a.name.cmp(&b.name))
            .then(a.path.cmp(&b.path))
    };
    while let Some(frame) = stack.last_mut() {
        if visited >= max_entries {
            break;
        }
        let Some(entry) = frame.entries.next() else {
            stack.pop();
            continue;
        };
        visited += 1;
        frame.position.offset += 1;
        let Ok(entry) = entry else {
            cursor.incomplete = true;
            continue;
        };
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            cursor.incomplete = true;
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            cursor.incomplete = true;
            continue;
        };
        if metadata.file_type().is_symlink()
            || (!metadata.is_file() && !metadata.is_dir())
            || metadata.is_dir()
                && matches!(
                    name.as_str(),
                    ".git"
                        | ".hg"
                        | ".svn"
                        | "node_modules"
                        | "target"
                        | "build"
                        | "dist"
                        | ".next"
                        | ".nuxt"
                        | ".svelte-kit"
                        | ".cache"
                        | ".venv"
                        | "venv"
                        | "__pycache__"
                        | "coverage"
                        | ".nimlo"
                        | ".relay-editor"
                )
        {
            continue;
        }
        let path = if frame.position.directory.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", frame.position.directory)
        };
        if path.len() > 4096 {
            cursor.incomplete = true;
            continue;
        }
        if name.to_lowercase().contains(&query) {
            let file = Entry {
                name,
                path: path.clone(),
                directory: metadata.is_dir(),
                size: metadata.len(),
            };
            let at = files
                .binary_search_by(|other| compare(other, &file))
                .unwrap_or_else(|at| at);
            files.insert(at, file);
            if files.len() > MAX_SEARCH_RESULTS {
                files.pop();
                overflow = true;
            }
        }
        if metadata.is_dir() {
            if stack.len() > max_depth {
                cursor.incomplete = true;
            } else {
                match resolve_root(root, &path, true)
                    .and_then(|parent| fs::read_dir(parent).map_err(Error::io))
                {
                    Ok(entries) => stack.push(Frame {
                        position: SearchFrame {
                            directory: path,
                            offset: 0,
                        },
                        entries,
                    }),
                    Err(_) => cursor.incomplete = true,
                }
            }
        }
    }
    cursor.frames = stack.into_iter().map(|frame| frame.position).collect();
    Ok(SearchPage {
        files,
        truncated: cursor.incomplete || overflow,
        cursor: (!cursor.frames.is_empty()).then_some(cursor),
    })
}

// The single-batch helper keeps the coverage/limit unit tests concise.
#[cfg(test)]
fn search_root(root: &Path, query: &str) -> Result<(Vec<Entry>, bool)> {
    let page = search_root_page(root, query, None)?;
    Ok((page.files, page.truncated || page.cursor.is_some()))
}

impl Workspace {
    /// Reads legacy ownership without allocating persisted document contents.
    pub fn recovery_owner(state_dir: &Path) -> Result<Option<PathBuf>> {
        let path = state_dir.join("drafts.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(Error::io(error)),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECOVERY
        {
            return Err(Error::new(
                "recovery",
                "Recovery snapshot ownership cannot be read safely",
            ));
        }
        let file = open_regular(&path, MAX_RECOVERY)?;
        let owner: RecoveryOwner = serde_json::from_reader(std::io::BufReader::new(
            file.take(MAX_RECOVERY + 1),
        ))
        .map_err(|error| {
            Error::new(
                "recovery",
                format!("Cannot read recovery ownership: {error}"),
            )
        })?;
        if !owner.workspace.is_absolute() {
            return Err(Error::new(
                "recovery",
                "Recovery workspace must be an absolute folder",
            ));
        }
        Ok(Some(owner.workspace))
    }
    pub fn new(root: &Path, state_override: Option<PathBuf>) -> Result<Self> {
        Self::new_with_budget(root, state_override, MAX_OPEN)
    }

    pub fn new_with_budget(
        root: &Path,
        state_override: Option<PathBuf>,
        max_open: usize,
    ) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(Error::io)?;
        if !root.is_dir() {
            return Err(Error::new("workspace", "Workspace must be a directory"));
        }
        let workspace_id = recovery_id(&root);
        let state_dir = state_override.unwrap_or_else(|| {
            let base = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            crate::branding::state_root(&base).join(workspace_id)
        });
        if fs::symlink_metadata(&state_dir).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(Error::new(
                "path",
                "Recovery directory must not be a symlink",
            ));
        }
        fs::create_dir_all(&state_dir).map_err(Error::io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&state_dir, fs::Permissions::from_mode(0o700))
                .map_err(Error::io)?;
        }
        let lock_path = state_dir.join("host.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::new("path", "Recovery lock must not be a symlink"));
        }
        let mut lock_options = OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            lock_options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let lock = lock_options.open(lock_path).map_err(Error::io)?;
        if !lock.metadata().map_err(Error::io)?.is_file() {
            return Err(Error::new("path", "Recovery lock must be a regular file"));
        }
        lock.try_lock_exclusive().map_err(|_| {
            Error::new(
                "workspace_busy",
                "Another Nimlo host already owns this workspace recovery directory",
            )
        })?;
        resume_checkpoint(&state_dir)?;
        for entry in fs::read_dir(&state_dir).map_err(Error::io)? {
            let entry = entry.map_err(Error::io)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() == 28
                && name.starts_with(".drafts-")
                && name.ends_with(".tmp")
                && name[8..24].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                let metadata = fs::symlink_metadata(entry.path()).map_err(Error::io)?;
                if metadata.is_file() && !metadata.file_type().is_symlink() {
                    fs::remove_file(entry.path()).map_err(Error::io)?;
                }
            }
        }
        #[cfg(unix)]
        let root_handle = File::open(&root).map_err(Error::io)?;
        let mut workspace = Self {
            root,
            #[cfg(unix)]
            root_handle: Some(root_handle),
            state_dir,
            documents: BTreeMap::new(),
            saved_histories: BTreeMap::new(),
            recent_paths: Vec::new(),
            revision_clock: 0,
            max_open,
            max_history: MAX_HISTORY,
            active_path: None,
            checkpoints: Mutex::new(BTreeMap::new()),
            recovery_poisoned: AtomicBool::new(false),
            _lock: Some(lock),
            #[cfg(test)]
            disk_reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            fail_commit_sync: AtomicBool::new(false),
            #[cfg(test)]
            fail_finish_sync: AtomicBool::new(false),
            #[cfg(test)]
            fail_prepare: AtomicBool::new(false),
        };
        workspace.recover()?;
        Ok(workspace)
    }

    pub fn name(&self) -> String {
        self.root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }

    /// Account retained data without cloning any document or history.
    pub fn usage(&self) -> (usize, usize, usize) {
        let mut bytes = 0;
        let mut history = 0;
        for document in self.documents.values() {
            bytes += document.content.len();
            history += document
                .undo
                .iter()
                .chain(&document.redo)
                .map(|text| text.len())
                .sum::<usize>();
        }
        history += self
            .saved_histories
            .values()
            .map(|saved| {
                saved
                    .undo
                    .iter()
                    .chain(&saved.redo)
                    .map(|text| text.len())
                    .sum::<usize>()
            })
            .sum::<usize>();
        (self.documents.len(), bytes, history)
    }

    pub fn session_budget(&mut self, max_open: usize, max_history: usize) {
        self.max_open = max_open;
        self.max_history = max_history;
    }

    pub fn release_clean_documents(&mut self) -> Result<()> {
        if self.has_unsaved() {
            return Err(Error::new(
                "unsaved",
                "Save or discard this project's changes first",
            ));
        }
        // Detaching changes session membership, not the folder's recovery or
        // files. A clean recovery remains available for a later host launch.
        self.documents.clear();
        self.saved_histories.clear();
        self.recent_paths.clear();
        self.active_path = None;
        self._lock.take();
        #[cfg(unix)]
        self.root_handle.take();
        Ok(())
    }

    pub fn is_attached(&self) -> bool {
        self._lock.is_some()
    }
    pub fn documents(&self) -> Vec<Document> {
        self.documents.values().map(Document::view).collect()
    }
    pub fn recent_files(&self) -> &[String] {
        &self.recent_paths
    }
    pub fn loaded_paths(&self) -> Vec<String> {
        self.documents.keys().cloned().collect()
    }
    fn remember_path(&mut self, path: &str) {
        self.recent_paths.retain(|old| old != path);
        self.recent_paths.insert(0, path.to_owned());
        while self.recent_paths.len() > MAX_RECENT_FILES
            || self.recent_paths.iter().map(String::len).sum::<usize>() > MAX_RECENT_PATH_BYTES
        {
            self.recent_paths.pop();
        }
        self.saved_histories
            .retain(|path, _| self.recent_paths.contains(path));
    }
    fn restore_saved_history(&mut self, document: &mut Document) {
        if let Some(history) = self.saved_histories.remove(&document.path)
            && history.saved_revision == document.saved_revision
        {
            document.undo = history.undo;
            document.redo = history.redo;
        }
    }
    fn prune_saved_inactive(&mut self) {
        let forgotten: Vec<_> = self
            .documents
            .iter()
            .filter(|(path, document)| {
                self.active_path.as_ref() != Some(path)
                    && !document.dirty
                    && document.conflict.is_none()
                    && !self.recent_paths.contains(path)
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in forgotten {
            self.remember_path(&path);
        }
        if let Some(path) = self.active_path.clone() {
            self.remember_path(&path);
        }
        let inactive: Vec<_> = self
            .documents
            .iter()
            .filter(|(path, document)| {
                self.active_path.as_ref() != Some(path)
                    && !document.dirty
                    && document.conflict.is_none()
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in inactive {
            let document = self.documents.remove(&path).unwrap();
            if self.recent_paths.contains(&path)
                && (!document.undo.is_empty() || !document.redo.is_empty())
            {
                self.saved_histories.insert(
                    path,
                    SavedHistory {
                        saved_revision: document.saved_revision,
                        undo: document.undo,
                        redo: document.redo,
                    },
                );
            }
        }
    }
    /// Release saved buffers while retaining bounded undo/redo for recent paths.
    /// Failed recovery commits restore every buffer and history entry.
    pub fn release_saved_inactive(&mut self) -> Result<()> {
        let before = self.documents.clone();
        let histories = self.saved_histories.clone();
        let recent = self.recent_paths.clone();
        self.prune_saved_inactive();
        if before.len() == self.documents.len() && recent == self.recent_paths {
            return Ok(());
        }
        if let Err(error) = self.persist() {
            self.documents = before;
            self.saved_histories = histories;
            self.recent_paths = recent;
            return Err(error);
        }
        Ok(())
    }
    pub fn document(&self, path: &str) -> Result<Document> {
        self.documents
            .get(path)
            .map(Document::view)
            .ok_or_else(|| Error::new("not_open", "Open this file first"))
    }
    pub fn has_unsaved(&self) -> bool {
        self.documents
            .values()
            .any(|document| document.dirty || document.conflict.is_some())
    }
    pub fn select(&mut self, path: &str) -> Result<()> {
        if !self.documents.contains_key(path) && !self.recent_paths.iter().any(|p| p == path) {
            return Err(Error::new("not_open", "Open this file first"));
        }
        self.open_selected(path).map(|_| ())
    }

    /// All workspace paths are relative, and symlinks are intentionally excluded.
    pub fn resolve(&self, relative: &str, directory: bool) -> Result<PathBuf> {
        resolve_root(&self.root, relative, directory)
    }
    pub fn list(&self, directory: &str) -> Result<Vec<Entry>> {
        list_root(&self.root, directory)
    }

    fn read_disk(&self, path: &str) -> Result<(String, String)> {
        #[cfg(test)]
        self.disk_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let absolute = self.resolve(path, false)?;
        #[cfg(unix)]
        let file = {
            let (parent, name) = self.parent_handle(path)?;
            anchored_open(&parent, &name, libc::O_RDONLY, 0).map_err(Error::io)?
        };
        #[cfg(not(unix))]
        let file = File::open(absolute).map_err(Error::io)?;
        #[cfg(unix)]
        let _ = absolute;
        if !file.metadata().map_err(Error::io)?.is_file() {
            return Err(Error::new("path", "Only regular files can be opened"));
        }
        if file.metadata().map_err(Error::io)?.len() > MAX_FILE as u64 {
            return Err(Error::new("limit", "Files are limited to 1 MiB"));
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(Error::io)?;
        if bytes.len() > MAX_FILE {
            return Err(Error::new("limit", "Files are limited to 1 MiB"));
        }
        let revision = fingerprint(&bytes);
        let content = String::from_utf8(bytes)
            .map_err(|_| Error::new("encoding", "Only UTF-8 text files can be edited"))?;
        if content.contains('\0') {
            return Err(Error::new("encoding", "Binary files cannot be edited"));
        }
        Ok((content, revision))
    }

    fn disk_observation(&self, path: &str) -> DiskObservation {
        let absolute = match self.resolve(path, false) {
            Ok(path) => path,
            Err(error) => return DiskObservation::Unavailable(error.code),
        };
        let metadata = match fs::symlink_metadata(absolute) {
            Ok(metadata) => metadata,
            Err(_) => return DiskObservation::Unavailable("io"),
        };
        if !metadata.is_file() {
            return DiskObservation::Unavailable("path");
        }
        metadata_observation(&metadata)
    }

    pub fn open(&mut self, path: &str) -> Result<Document> {
        self.recovery_ready()?;
        self.resolve(path, false)?;
        if let Some(document) = self.documents.get(path) {
            return Ok(document.view());
        }
        if self.documents.len() >= self.max_open {
            return Err(Error::new(
                "limit",
                "Close a file before opening more than eight",
            ));
        }
        let observation = self.disk_observation(path);
        let (content, saved_revision) = self.read_disk(path)?;
        let mut document = Document {
            path: path.into(),
            content: content.into(),
            revision: next_revision(&mut self.revision_clock)?,
            dirty: false,
            conflict: None,
            saved_revision,
            undo: VecDeque::new(),
            redo: VecDeque::new(),
            disk_observation: Some(observation),
        };
        let recent = self.recent_paths.clone();
        let histories = self.saved_histories.clone();
        self.restore_saved_history(&mut document);
        self.remember_path(path);
        self.documents.insert(path.into(), document.clone());
        if let Err(error) = self.persist() {
            self.documents.remove(path);
            self.recent_paths = recent;
            self.saved_histories = histories;
            return Err(error);
        }
        Ok(document)
    }

    /// Switching files is one recovery transaction: read a replacement before
    /// releasing the previous saved buffer, and never evict an unsaved draft.
    pub fn open_selected(&mut self, path: &str) -> Result<Document> {
        self.recovery_ready()?;
        let incoming = if self.documents.contains_key(path) {
            None
        } else {
            let retained = self
                .documents
                .values()
                .filter(|document| document.dirty || document.conflict.is_some())
                .count();
            if retained >= self.max_open {
                return Err(Error::new(
                    "limit",
                    "Save or close an unsaved file before opening more files",
                ));
            }
            let observation = self.disk_observation(path);
            let (content, saved_revision) = self.read_disk(path)?;
            Some(Document {
                path: path.into(),
                content: content.into(),
                revision: next_revision(&mut self.revision_clock)?,
                dirty: false,
                conflict: None,
                saved_revision,
                undo: VecDeque::new(),
                redo: VecDeque::new(),
                disk_observation: Some(observation),
            })
        };
        let before = self.documents.clone();
        let histories = self.saved_histories.clone();
        let recent = self.recent_paths.clone();
        let active = self.active_path.replace(path.into());
        if let Some(mut document) = incoming {
            self.restore_saved_history(&mut document);
            self.documents.insert(path.into(), document);
        }
        self.remember_path(path);
        self.prune_saved_inactive();
        if let Err(error) = self.persist() {
            self.documents = before;
            self.saved_histories = histories;
            self.recent_paths = recent;
            self.active_path = active;
            return Err(error);
        }
        Ok(self.documents[path].view())
    }

    #[cfg(test)]
    pub fn create(&mut self, path: &str, content: String) -> Result<Document> {
        self.create_with_selection(path, content, false)
    }

    pub fn create_selected(&mut self, path: &str, content: String) -> Result<Document> {
        self.create_with_selection(path, content, true)
    }

    fn create_with_selection(
        &mut self,
        path: &str,
        content: String,
        select: bool,
    ) -> Result<Document> {
        self.recovery_ready()?;
        if content.len() > MAX_FILE || content.contains('\0') {
            return Err(Error::new(
                "limit",
                "New files must be UTF-8 text of at most 1 MiB",
            ));
        }
        let retained = if select {
            self.documents
                .values()
                .filter(|document| document.dirty || document.conflict.is_some())
                .count()
        } else {
            self.documents.len()
        };
        if retained >= self.max_open {
            return Err(Error::new(
                "limit",
                "Close a file before opening more than eight",
            ));
        }
        let relative = Path::new(path);
        if path.is_empty()
            || path.len() > 4096
            || path.contains('\\')
            || relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(Error::new(
                "path",
                "Use a relative filename without traversal",
            ));
        }
        let parent_relative = relative
            .parent()
            .unwrap_or(Path::new(""))
            .to_str()
            .ok_or_else(|| Error::new("path", "Use a UTF-8 path"))?;
        let parent = self.resolve(parent_relative, true)?;
        #[cfg(unix)]
        let _ = &parent;
        #[cfg(not(unix))]
        let absolute = parent.join(relative.file_name().unwrap());
        #[cfg(unix)]
        let (parent_handle, name) = self.parent_handle(path)?;
        #[cfg(unix)]
        let creation = anchored_open(
            &parent_handle,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        );
        #[cfg(not(unix))]
        let creation = private_options().open(&absolute);
        let mut file = creation.map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Error::new("exists", "A file already exists at this path")
            } else {
                Error::io(error)
            }
        })?;
        let write = file
            .write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .and_then(|_| {
                #[cfg(unix)]
                {
                    parent_handle.sync_all()
                }
                #[cfg(not(unix))]
                {
                    sync_directory(&parent)
                }
            });
        if let Err(error) = write {
            #[cfg(unix)]
            let _ = anchored_unlink(&parent_handle, &name);
            #[cfg(not(unix))]
            let _ = fs::remove_file(&absolute);
            return Err(Error::io(error));
        }
        if select {
            self.open_selected(path)
        } else {
            self.open(path)
        }
    }

    fn check_revision(&self, path: &str, revision: u64) -> Result<()> {
        self.recovery_ready()?;
        let document = self
            .documents
            .get(path)
            .ok_or_else(|| Error::new("not_open", "Open this file first"))?;
        if document.revision != revision {
            return Err(Error::new(
                "stale_revision",
                "This edit is based on an older document; preserve it locally and reload the host version",
            ));
        }
        Ok(())
    }

    fn trim_history(&mut self, protect: Option<&str>) {
        for document in self.documents.values_mut() {
            while document.undo.len() > 20 {
                document.undo.pop_front();
            }
            while document.redo.len() > 20 {
                document.redo.pop_front();
            }
        }
        while self.usage().2 > self.max_history {
            // Discard the least recently visited unloaded history first. It is
            // charged to the same session budget as loaded documents' history.
            if let Some(path) = self
                .recent_paths
                .iter()
                .rev()
                .find(|path| self.saved_histories.contains_key(*path))
                .cloned()
            {
                self.saved_histories.remove(&path);
                continue;
            }
            // Preserve the latest mutation's undo/redo before older files'
            // history. Lexical iteration alone could immediately evict a new
            // large file's only Undo while retaining inactive files' history.
            // The same byte cap still applies to the protected file itself.
            let victim = self
                .documents
                .iter()
                .find(|(path, d)| {
                    protect != Some(path.as_str()) && (!d.undo.is_empty() || !d.redo.is_empty())
                })
                .or_else(|| {
                    self.documents
                        .iter()
                        .find(|(_, d)| !d.undo.is_empty() || !d.redo.is_empty())
                })
                .map(|(path, _)| path.clone());
            if let Some(document) = victim.and_then(|path| self.documents.get_mut(&path)) {
                if document.undo.pop_front().is_none() {
                    document.redo.pop_front();
                }
            } else {
                break;
            }
        }
    }

    pub fn edit(&mut self, path: &str, revision: u64, content: String) -> Result<Document> {
        self.check_revision(path, revision)?;
        if content.len() > MAX_FILE || content.contains('\0') {
            return Err(Error::new(
                "limit",
                "Edits must be UTF-8 text of at most 1 MiB",
            ));
        }
        let old = self.documents[path].clone();
        let total = self
            .documents
            .values()
            .map(|d| d.content.len())
            .sum::<usize>()
            - old.content.len()
            + content.len();
        if total > MAX_BUFFERS {
            return Err(Error::new(
                "limit",
                "Loaded documents exceed the 8 MiB buffer limit",
            ));
        }
        let document = self.documents.get_mut(path).unwrap();
        if document.content == content {
            return Ok(document.view());
        }
        let revision = next_revision(&mut self.revision_clock)?;
        document
            .undo
            .push_back(std::mem::replace(&mut document.content, content.into()));
        document.redo.clear();
        document.revision = revision;
        document.dirty = fingerprint(document.content.as_bytes()) != document.saved_revision;
        if let Err(error) = self.persist() {
            self.documents.insert(path.into(), old);
            return Err(error);
        }
        // History is not part of recovery. Trim only after durable persistence
        // so a failed edit cannot evict another document's acknowledged history.
        self.trim_history(Some(path));
        Ok(self.documents[path].view())
    }

    /// Browser splice offsets are UTF-16 units, never byte or half-surrogate offsets.
    pub fn patch(
        &mut self,
        path: &str,
        revision: u64,
        start: u64,
        delete_count: u64,
        insert: String,
    ) -> Result<Document> {
        self.check_revision(path, revision)?;
        if insert.len() > MAX_FILE || insert.contains('\0') {
            return Err(Error::new(
                "limit",
                "Patch text must be UTF-8 text of at most 1 MiB",
            ));
        }
        let end = start
            .checked_add(delete_count)
            .ok_or_else(|| Error::new("patch", "Patch range overflow"))?;
        let old: &str = &self.documents[path].content;
        let boundary = |target: u64| -> Result<usize> {
            let mut units = 0u64;
            for (byte, ch) in old.char_indices() {
                if units == target {
                    return Ok(byte);
                }
                units += ch.len_utf16() as u64;
                if units > target {
                    return Err(Error::new(
                        "patch",
                        "Patch range splits a Unicode character",
                    ));
                }
            }
            if units == target {
                Ok(old.len())
            } else {
                Err(Error::new("patch", "Patch range is outside the document"))
            }
        };
        let first = boundary(start)?;
        let last = boundary(end)?;
        let length = old.len() - (last - first) + insert.len();
        if length > MAX_FILE {
            return Err(Error::new("limit", "Patched files are limited to 1 MiB"));
        }
        let mut content = String::with_capacity(length);
        content.push_str(&old[..first]);
        content.push_str(&insert);
        content.push_str(&old[last..]);
        self.edit(path, revision, content)
    }

    pub fn file_snapshot(&self, path: &str) -> Result<Document> {
        self.documents
            .get(path)
            .map(Document::view)
            .ok_or_else(|| Error::new("file_closed", "This file is no longer open"))
    }

    pub fn undo(&mut self, path: &str, revision: u64, redo: bool) -> Result<Document> {
        self.check_revision(path, revision)?;
        let old = self.documents[path].clone();
        let document = self.documents.get_mut(path).unwrap();
        if (if redo { &document.redo } else { &document.undo }).is_empty() {
            return Err(Error::new("history", "No more retained history"));
        }
        let revision = next_revision(&mut self.revision_clock)?;
        let restored = if redo {
            document.redo.pop_back()
        } else {
            document.undo.pop_back()
        }
        .ok_or_else(|| Error::new("history", "No more retained history"))?;
        let previous = std::mem::replace(&mut document.content, restored);
        if redo {
            document.undo.push_back(previous);
        } else {
            document.redo.push_back(previous);
        }
        document.revision = revision;
        document.dirty = fingerprint(document.content.as_bytes()) != document.saved_revision;
        if let Err(error) = self.persist() {
            self.documents.insert(path.into(), old);
            return Err(error);
        }
        self.trim_history(Some(path));
        Ok(self.documents[path].view())
    }

    pub fn save(&mut self, path: &str, revision: u64) -> Result<Document> {
        self.check_revision(path, revision)?;
        self.refresh_one(path)?;
        self.check_revision(path, revision)?;
        let before = self.documents[path].clone();
        let document = &before;
        if document.conflict.is_some() {
            return Err(Error::new(
                "disk_conflict",
                "Disk changed too; choose which version to keep before saving",
            ));
        }
        let absolute = self.resolve(path, false)?;
        let parent = absolute.parent().unwrap();
        let temporary = parent.join(format!(".nimlo-save-{:016x}.tmp", rand::random::<u64>()));
        #[cfg(unix)]
        let (parent_handle, target_name) = self.parent_handle(path)?;
        #[cfg(unix)]
        let temporary_name = temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let result = (|| {
            #[cfg(unix)]
            let mut file = anchored_open(
                &parent_handle,
                &temporary_name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
            .map_err(Error::io)?;
            #[cfg(not(unix))]
            let mut file = private_options().open(&temporary).map_err(Error::io)?;
            #[cfg(unix)]
            let permissions = anchored_open(&parent_handle, &target_name, libc::O_RDONLY, 0)
                .and_then(|file| file.metadata())
                .map_err(Error::io)?
                .permissions();
            #[cfg(not(unix))]
            let permissions = fs::metadata(&absolute).map_err(Error::io)?.permissions();
            file.set_permissions(permissions).map_err(Error::io)?;
            file.write_all(document.content.as_bytes())
                .map_err(Error::io)?;
            file.sync_all().map_err(Error::io)?;
            let (_, current_revision) = self.read_disk(path)?;
            if current_revision != document.saved_revision {
                return Err(Error::new(
                    "disk_conflict",
                    "Disk changed while preparing the save; retry after reviewing it",
                ));
            }
            self.resolve(path, false)?;
            #[cfg(unix)]
            anchored_rename(&parent_handle, &temporary_name, &target_name).map_err(Error::io)?;
            #[cfg(not(unix))]
            fs::rename(&temporary, &absolute).map_err(Error::io)?;
            #[cfg(unix)]
            parent_handle.sync_all().map_err(Error::io)?;
            #[cfg(not(unix))]
            sync_directory(parent).map_err(Error::io)?;
            Ok(())
        })();
        if result.is_err() {
            #[cfg(unix)]
            let _ = anchored_unlink(&parent_handle, &temporary_name);
            #[cfg(not(unix))]
            let _ = fs::remove_file(&temporary);
        }
        result?;
        let document = self.documents.get_mut(path).unwrap();
        document.saved_revision = fingerprint(document.content.as_bytes());
        document.dirty = false;
        document.conflict = None;
        // Recheck once after the rename, including changes made immediately after it.
        document.disk_observation = None;
        if let Err(error) = self.persist() {
            // The disk rename already succeeded. Keep the previous in-memory
            // draft on checkpoint failure; the next disk refresh can reconcile
            // the saved bytes without acknowledging an undurable state change.
            self.documents.insert(path.into(), before);
            return Err(error);
        }
        Ok(self.documents[path].view())
    }

    #[cfg(unix)]
    fn parent_handle(&self, relative: &str) -> Result<(File, String)> {
        let path = Path::new(relative);
        if path.is_absolute()
            || relative.contains('\\')
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(Error::new("path", "Unsafe workspace path"));
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::new("path", "Use a UTF-8 filename"))?
            .to_owned();
        let mut parent = self
            .root_handle
            .as_ref()
            .ok_or_else(|| Error::new("project", "This project was detached"))?
            .try_clone()
            .map_err(Error::io)?;
        if let Some(parent_path) = path.parent() {
            for component in parent_path.components() {
                parent = anchored_open(
                    &parent,
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or_else(|| Error::new("path", "Use a UTF-8 directory"))?,
                    libc::O_RDONLY | libc::O_DIRECTORY,
                    0,
                )
                .map_err(Error::io)?;
            }
        }
        Ok((parent, name))
    }

    pub fn close(&mut self, path: &str, discard: bool) -> Result<()> {
        self.recovery_ready()?;
        let document = self.documents.get(path);
        if document.is_none() && !self.recent_paths.iter().any(|old| old == path) {
            return Err(Error::new("not_open", "File is not open"));
        }
        if document.is_some_and(|document| document.dirty || document.conflict.is_some())
            && !discard
        {
            return Err(Error::new(
                "unsaved",
                "Save this file or explicitly discard its unsaved changes",
            ));
        }
        let document = self.documents.remove(path);
        let recent = self.recent_paths.clone();
        self.recent_paths.retain(|old| old != path);
        let active_path = self.active_path.clone();
        if self.active_path.as_deref() == Some(path) {
            self.active_path = self.documents.keys().next().cloned();
        }
        if let Err(error) = self.persist() {
            if let Some(document) = document {
                self.documents.insert(path.into(), document);
            }
            self.recent_paths = recent;
            self.active_path = active_path;
            return Err(error);
        }
        self.saved_histories.remove(path);
        Ok(())
    }

    pub fn resolve_conflict(
        &mut self,
        path: &str,
        revision: u64,
        disk_revision: &str,
        resolution: &str,
    ) -> Result<Document> {
        self.check_revision(path, revision)?;
        self.refresh_one(path)?;
        self.check_revision(path, revision)?;
        let old = self.documents[path].clone();
        let conflict = old
            .conflict
            .as_ref()
            .ok_or_else(|| Error::new("disk_conflict", "No disk conflict exists"))?;
        if conflict.disk_revision != disk_revision {
            return Err(Error::new(
                "disk_conflict",
                "Disk changed again; review the latest version",
            ));
        }
        let document = self.documents.get_mut(path).unwrap();
        match resolution {
            "disk" => {
                let disk = conflict.disk_content.clone().ok_or_else(|| {
                    Error::new(
                        "disk_conflict",
                        "Disk file is missing or cannot be loaded; preserve the buffer",
                    )
                })?;
                let revision = next_revision(&mut self.revision_clock)?;
                document
                    .undo
                    .push_back(std::mem::replace(&mut document.content, disk));
                document.redo.clear();
                document.revision = revision;
                document.saved_revision = disk_revision.into();
                document.dirty = false;
                document.conflict = None;
            }
            "buffer" => {
                if conflict.disk_content.is_none() {
                    return Err(Error::new(
                        "disk_conflict",
                        "Restore the missing or unsupported disk file before saving",
                    ));
                }
                document.saved_revision = disk_revision.into();
                document.dirty = fingerprint(document.content.as_bytes()) != disk_revision;
                document.conflict = None;
            }
            _ => {
                return Err(Error::new(
                    "invalid",
                    "Resolution must be 'disk' or 'buffer'",
                ));
            }
        }
        if let Err(error) = self.persist() {
            self.documents.insert(path.into(), old);
            return Err(error);
        }
        self.trim_history(Some(path));
        Ok(self.documents[path].view())
    }

    fn refresh_one(&mut self, path: &str) -> Result<bool> {
        let observation = self.disk_observation(path);
        let disk = self.read_disk(path);
        let document = self.documents.get_mut(path).unwrap();
        document.disk_observation = Some(observation);
        let (content, revision) = match disk {
            Ok(value) => value,
            Err(error) => {
                let revision = format!("unavailable:{}", error.code);
                if document
                    .conflict
                    .as_ref()
                    .is_some_and(|c| c.disk_revision == revision)
                {
                    return Ok(false);
                }
                document.conflict = Some(Conflict {
                    disk_content: None,
                    disk_revision: revision,
                });
                return Ok(true);
            }
        };
        if revision == document.saved_revision {
            if document.conflict.take().is_some() {
                return Ok(true);
            }
            return Ok(false);
        }
        if !document.dirty || document.content == content {
            if document.content != content {
                let next = next_revision(&mut self.revision_clock)?;
                document
                    .undo
                    .push_back(std::mem::replace(&mut document.content, content.into()));
                document.redo.clear();
                document.revision = next;
            }
            document.saved_revision = revision;
            document.dirty = false;
            document.conflict = None;
            return Ok(true);
        }
        if document
            .conflict
            .as_ref()
            .is_some_and(|c| c.disk_revision == revision)
        {
            return Ok(false);
        }
        document.conflict = Some(Conflict {
            disk_content: Some(content.into()),
            disk_revision: revision,
        });
        Ok(true)
    }

    pub fn refresh(&mut self) -> Result<Vec<Document>> {
        let paths: Vec<_> = self
            .documents
            .iter()
            .filter_map(|(path, document)| {
                let observation = self.disk_observation(path);
                (document.disk_observation.as_ref() != Some(&observation)).then(|| path.clone())
            })
            .collect();
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let before = self.documents.clone();
        let mut changed = Vec::new();
        for path in paths {
            match self.refresh_one(&path) {
                Ok(true) => changed.push(self.documents[&path].view()),
                Ok(false) => {}
                Err(error) => {
                    self.documents = before;
                    return Err(error);
                }
            }
        }
        if !changed.is_empty() {
            if let Err(error) = self.persist() {
                self.documents = before;
                return Err(error);
            }
            let active = self.active_path.clone();
            self.trim_history(active.as_deref());
        }
        Ok(changed)
    }

    fn recover(&mut self) -> Result<()> {
        let path = self.state_dir.join("drafts.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(Error::io(error)),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECOVERY
        {
            return Err(Error::new(
                "recovery",
                "Recovery snapshot is unsafe or too large; preserve it and choose another --state-dir",
            ));
        }
        let mut bytes = Vec::new();
        open_regular(&path, MAX_RECOVERY)?
            .take(MAX_RECOVERY + 1)
            .read_to_end(&mut bytes)
            .map_err(Error::io)?;
        if bytes.len() as u64 > MAX_RECOVERY {
            return Err(Error::new(
                "recovery",
                "Recovery snapshot exceeds its bounded size",
            ));
        }
        let version: RecoveryVersion = serde_json::from_slice(&bytes).map_err(|error| {
            Error::new("recovery", format!("Recovery snapshot is invalid: {error}"))
        })?;
        let recovery = if version.version == 1 {
            serde_json::from_slice::<Recovery>(&bytes).map_err(|error| {
                Error::new("recovery", format!("Recovery snapshot is invalid: {error}"))
            })?
        } else if version.version == 2 && bytes.len() as u64 <= MAX_MANIFEST {
            let manifest: RecoveryManifest = serde_json::from_slice(&bytes).map_err(|error| {
                Error::new("recovery", format!("Recovery manifest is invalid: {error}"))
            })?;
            if manifest.workspace != self.root || manifest.documents.len() > MAX_OPEN {
                return Err(Error::new(
                    "recovery",
                    "Recovery manifest does not match this workspace",
                ));
            }
            let mut documents = Vec::with_capacity(manifest.documents.len());
            let mut records = BTreeMap::new();
            for reference in manifest.documents {
                if !record_name(&reference.record) || records.contains_key(&reference.path) {
                    return Err(Error::new(
                        "recovery",
                        "Recovery manifest contains an invalid document record",
                    ));
                }
                let mut bytes = Vec::new();
                let stored = open_regular(&self.state_dir.join(&reference.record), MAX_RECORD)?;
                let observation = metadata_observation(&stored.metadata().map_err(Error::io)?);
                stored
                    .take(MAX_RECORD + 1)
                    .read_to_end(&mut bytes)
                    .map_err(Error::io)?;
                if bytes.len() as u64 > MAX_RECORD || fingerprint(&bytes) != reference.record[9..73]
                {
                    return Err(Error::new(
                        "recovery",
                        "Recovery document checksum does not match",
                    ));
                }
                let document: Document = serde_json::from_slice(&bytes).map_err(|error| {
                    Error::new("recovery", format!("Recovery document is invalid: {error}"))
                })?;
                if document.path != reference.path {
                    return Err(Error::new(
                        "recovery",
                        "Recovery document path does not match its manifest",
                    ));
                }
                records.insert(
                    reference.path.clone(),
                    Checkpoint {
                        signature: CheckpointSignature::of(&document),
                        reference,
                        observation,
                    },
                );
                documents.push(document);
            }
            *self.checkpoints.lock().unwrap() = records;
            Recovery {
                version: 2,
                workspace: manifest.workspace,
                active_path: manifest.active_path,
                recent_paths: manifest.recent_paths,
                revision_clock: manifest.revision_clock,
                documents,
            }
        } else {
            return Err(Error::new(
                "recovery",
                "Recovery snapshot version or manifest size is invalid",
            ));
        };
        if !matches!(recovery.version, 1 | 2)
            || recovery.workspace != self.root
            || recovery.documents.len() > MAX_OPEN
        {
            return Err(Error::new(
                "recovery",
                "Recovery snapshot does not match this workspace",
            ));
        }
        if recovery.revision_clock > MAX_REVISION
            || recovery.recent_paths.len() > MAX_RECENT_FILES
            || recovery.recent_paths.iter().map(String::len).sum::<usize>() > MAX_RECENT_PATH_BYTES
        {
            return Err(Error::new(
                "recovery",
                "Recovery shortcut metadata exceeds its bounded size",
            ));
        }
        let mut seen = BTreeSet::new();
        for path in &recovery.recent_paths {
            if !safe_file_path(path) || !seen.insert(path) {
                return Err(Error::new(
                    "recovery",
                    "Recovery contains an unsafe shortcut path",
                ));
            }
        }
        let mut total = 0;
        self.active_path = recovery.active_path;
        self.recent_paths = recovery.recent_paths;
        self.revision_clock = recovery.revision_clock;
        for document in recovery.documents {
            total += document.content.len();
            if document.revision == 0
                || document.revision > MAX_REVISION
                || document.content.len() > MAX_FILE
                || total > MAX_BUFFERS
                || document
                    .conflict
                    .as_ref()
                    .is_some_and(|c| c.disk_content.as_ref().is_some_and(|s| s.len() > MAX_FILE))
            {
                return Err(Error::new(
                    "recovery",
                    "Recovery snapshot exceeds document limits",
                ));
            }
            if !safe_file_path(&document.path) || self.documents.contains_key(&document.path) {
                return Err(Error::new(
                    "recovery",
                    "Recovery snapshot has an unsafe path",
                ));
            }
            self.revision_clock = self.revision_clock.max(document.revision);
            self.documents.insert(document.path.clone(), document);
        }
        if !self
            .active_path
            .as_ref()
            .is_some_and(|path| self.documents.contains_key(path))
        {
            self.active_path = self.documents.keys().next().cloned();
        }
        let before_recent = self.recent_paths.clone();
        for path in self
            .documents
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            if !self.recent_paths.contains(&path) {
                self.remember_path(&path);
            }
        }
        if let Some(path) = self.active_path.clone() {
            self.remember_path(&path);
        }
        let before_count = self.documents.len();
        self.prune_saved_inactive();
        if self.documents.len() > self.max_open {
            return Err(Error::new(
                "limit",
                "Save or close recovered drafts in another project before loading this project",
            ));
        }
        self.refresh()?;
        if before_count != self.documents.len() || before_recent != self.recent_paths {
            self.persist()?;
        }
        Ok(())
    }

    fn recovery_ready(&self) -> Result<()> {
        if self.recovery_poisoned.load(Ordering::Acquire) {
            Err(Error::new(
                "recovery_ambiguous",
                "Recovery durability is uncertain. Further changes are stopped; preserve this state directory and restart with another --state-dir.",
            ))
        } else {
            Ok(())
        }
    }

    fn remove_uncommitted(&self, records: &BTreeSet<String>) {
        for record in records {
            let path = self.state_dir.join(record);
            if fs::symlink_metadata(&path)
                .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn persist(&self) -> Result<()> {
        self.recovery_ready()?;
        let prior = self.checkpoints.lock().unwrap().clone();
        let protected: BTreeSet<_> = prior
            .values()
            .map(|checkpoint| checkpoint.reference.record.clone())
            .chain(manifest_records(
                &self.state_dir.join("drafts.previous.json"),
            ))
            .chain(manifest_records(
                &self.state_dir.join("drafts.interrupted.json"),
            ))
            .collect();
        let mut created = BTreeSet::new();
        let mut next = BTreeMap::new();
        for document in self.documents.values() {
            let signature = CheckpointSignature::of(document);
            let checkpoint = if let Some(old) = prior.get(&document.path).filter(|old| {
                old.signature == signature
                    && checkpoint_observation(&self.state_dir.join(&old.reference.record))
                        .is_ok_and(|now| now == old.observation)
            }) {
                old.clone()
            } else {
                let temporary = self
                    .state_dir
                    .join(format!(".drafts-{:016x}.tmp", rand::random::<u64>()));
                let result = (|| {
                    let mut file = private_options().open(&temporary).map_err(Error::io)?;
                    let digest = {
                        let mut writer = HashWriter {
                            inner: BufWriter::with_capacity(16 * 1024, &mut file),
                            hash: Sha256::new(),
                        };
                        serde_json::to_writer(
                            &mut writer,
                            &RecoveryDocument {
                                path: &document.path,
                                content: &document.content,
                                revision: document.revision,
                                dirty: document.dirty,
                                conflict: &document.conflict,
                                saved_revision: &document.saved_revision,
                            },
                        )
                        .map_err(Error::io)?;
                        writer.flush().map_err(Error::io)?;
                        format!("{:x}", writer.hash.finalize())
                    };
                    if file.metadata().map_err(Error::io)?.len() > MAX_RECORD {
                        return Err(Error::new(
                            "limit",
                            "Recovery document exceeds its bounded size",
                        ));
                    }
                    file.sync_all().map_err(Error::io)?;
                    let record = format!("document-{digest}.json");
                    let destination = self.state_dir.join(&record);
                    let fresh = fs::symlink_metadata(&destination)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                        && !protected.contains(&record);
                    fs::rename(&temporary, &destination).map_err(Error::io)?;
                    if fresh {
                        created.insert(record.clone());
                    }
                    Ok(Checkpoint {
                        signature,
                        observation: checkpoint_observation(&self.state_dir.join(&record))?,
                        reference: RecoveryReference {
                            path: document.path.clone(),
                            record,
                        },
                    })
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temporary);
                }
                result.inspect_err(|_| {
                    self.remove_uncommitted(&created);
                })?
            };
            next.insert(document.path.clone(), checkpoint);
        }
        let current = self.state_dir.join("drafts.json");
        let backup = self.state_dir.join("drafts.previous.json");
        let marker = self.state_dir.join(".recovery-transaction");
        let had_prior = fs::symlink_metadata(&current).is_ok();
        let manifest = RecoveryManifest {
            version: 2,
            workspace: self.root.clone(),
            active_path: self.active_path.clone(),
            recent_paths: self.recent_paths.clone(),
            revision_clock: self.revision_clock,
            documents: next
                .values()
                .map(|checkpoint| checkpoint.reference.clone())
                .collect(),
            previous: had_prior,
        };
        let temporary = self
            .state_dir
            .join(format!(".drafts-{:016x}.tmp", rand::random::<u64>()));
        let backup_temp = self
            .state_dir
            .join(format!(".drafts-{:016x}.tmp", rand::random::<u64>()));
        let mut marker_created = false;
        let mut renamed = false;
        let result = (|| {
            let mut file = private_options().open(&temporary).map_err(Error::io)?;
            {
                let mut writer = BufWriter::with_capacity(16 * 1024, &mut file);
                serde_json::to_writer(&mut writer, &manifest).map_err(Error::io)?;
                writer.flush().map_err(Error::io)?;
            }
            if file.metadata().map_err(Error::io)?.len() > MAX_MANIFEST {
                return Err(Error::new(
                    "limit",
                    "Recovery manifest exceeds its bounded size",
                ));
            }
            file.sync_all().map_err(Error::io)?;
            #[cfg(test)]
            if self.fail_prepare.load(Ordering::Relaxed) {
                return Err(Error::new("io", "Injected precommit failure"));
            }
            if had_prior {
                // A hard link preserves even a large v1 checkpoint without copying it into RAM.
                let _verified = open_regular(&current, MAX_RECOVERY)?;
                fs::hard_link(&current, &backup_temp).map_err(Error::io)?;
                fs::rename(&backup_temp, &backup).map_err(Error::io)?;
            }
            // The manifest already contains the rollback bit and has been
            // synced. Reuse its inode instead of serializing and syncing a
            // second file. The existing directory barrier installs both names.
            fs::hard_link(&temporary, &marker).map_err(Error::io)?;
            marker_created = true;
            // Commit record names and the prior manifest before installing the next manifest.
            sync_directory(&self.state_dir).map_err(Error::io)?;
            fs::rename(&temporary, &current).map_err(Error::io)?;
            renamed = true;
            #[cfg(test)]
            if self.fail_commit_sync.load(Ordering::Relaxed) {
                return Err(Error::new(
                    "io",
                    "Injected post-rename directory sync failure",
                ));
            }
            sync_directory(&self.state_dir).map_err(Error::io)?;
            fs::remove_file(&marker).map_err(Error::io)?;
            #[cfg(test)]
            if self.fail_finish_sync.load(Ordering::Relaxed) {
                return Err(Error::new("io", "Injected marker-removal sync failure"));
            }
            sync_directory(&self.state_dir).map_err(Error::io)?;
            Ok(())
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&backup_temp);
            if renamed {
                // Never acknowledge, claim rollback, or collect records after an uncertain commit.
                self.recovery_poisoned.store(true, Ordering::Release);
                if !marker.exists()
                    && let Ok(mut file) = private_options().open(&marker)
                {
                    let _ = serde_json::to_writer(
                        &mut file,
                        &RecoveryIntent {
                            previous: backup.exists(),
                        },
                    );
                    let _ = file.sync_all();
                    let _ = sync_directory(&self.state_dir);
                }
                return Err(Error::new(
                    "recovery_ambiguous",
                    format!(
                        "Recovery commit durability is uncertain ({}); preserve current and previous checkpoints. Further changes are stopped.",
                        error.message
                    ),
                ));
            }
            if marker_created
                && (fs::remove_file(&marker).is_err() || sync_directory(&self.state_dir).is_err())
            {
                self.recovery_poisoned.store(true, Ordering::Release);
                return Err(Error::new(
                    "recovery_ambiguous",
                    "Recovery transaction cleanup failed; preserve the state directory. Further changes are stopped.",
                ));
            }
            self.remove_uncommitted(&created);
            return Err(error);
        }
        *self.checkpoints.lock().unwrap() = next.clone();
        // Both manifests stay readable. Only successfully committed transactions collect old records.
        let keep: BTreeSet<_> = next
            .values()
            .chain(prior.values())
            .map(|checkpoint| checkpoint.reference.record.clone())
            .chain(manifest_records(
                &self.state_dir.join("drafts.interrupted.json"),
            ))
            .collect();
        if let Ok(entries) = fs::read_dir(&self.state_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if record_name(&name)
                    && !keep.contains(name.as_str())
                    && fs::symlink_metadata(entry.path()).is_ok_and(|metadata| {
                        metadata.is_file() && !metadata.file_type().is_symlink()
                    })
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, tempfile::TempDir, Workspace) {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        fs::write(root.path().join("hello.txt"), "hello").unwrap();
        let workspace = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        (root, state, workspace)
    }
    #[test]
    fn patches_validate_utf16_ranges_and_preserve_history_and_recovery() {
        let (root, state, mut workspace) = setup();
        fs::write(root.path().join("hello.txt"), "a🙂雪z").unwrap();
        let opened = workspace.open("hello.txt").unwrap();
        for (start, count, insert) in [
            (2, 0, "x"),
            (1, 1, "x"),
            (50, 0, "x"),
            (u64::MAX, 1, "x"),
            (0, 0, "\0"),
        ] {
            assert!(
                workspace
                    .patch("hello.txt", opened.revision, start, count, insert.into())
                    .is_err()
            );
            assert_eq!(
                workspace.file_snapshot("hello.txt").unwrap().content,
                "a🙂雪z"
            );
        }
        let edited = workspace
            .patch("hello.txt", opened.revision, 1, 2, "🚀".into())
            .unwrap();
        assert_eq!(edited.content, "a🚀雪z");
        assert_eq!(
            workspace
                .patch("hello.txt", opened.revision, 0, 0, "stale".into())
                .unwrap_err()
                .code,
            "stale_revision"
        );
        let noop = workspace
            .patch("hello.txt", edited.revision, 3, 0, "".into())
            .unwrap();
        assert_eq!(noop.revision, edited.revision);
        let undone = workspace.undo("hello.txt", edited.revision, false).unwrap();
        assert_eq!(undone.content, opened.content);
        let redone = workspace.undo("hello.txt", undone.revision, true).unwrap();
        assert_eq!(redone.content, edited.content);
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot("hello.txt").unwrap().content,
            edited.content
        );
    }

    #[test]
    fn patch_growth_is_bounded_without_changing_the_checkpoint() {
        let (root, state, mut workspace) = setup();
        fs::write(root.path().join("hello.txt"), "x".repeat(MAX_FILE)).unwrap();
        let opened = workspace.open("hello.txt").unwrap();
        let before = fs::read(state.path().join("drafts.json")).unwrap();
        assert_eq!(
            workspace
                .patch("hello.txt", opened.revision, 0, 0, "x".into())
                .unwrap_err()
                .code,
            "limit"
        );
        assert_eq!(
            workspace.file_snapshot("hello.txt").unwrap().revision,
            opened.revision
        );
        assert_eq!(fs::read(state.path().join("drafts.json")).unwrap(), before);
    }

    fn manifest(state: &Path) -> RecoveryManifest {
        serde_json::from_slice(&fs::read(state.join("drafts.json")).unwrap()).unwrap()
    }

    #[test]
    fn recovery_writes_only_the_changed_document_and_keeps_two_commits_bounded() {
        let (root, state, mut workspace) = setup();
        for i in 0..MAX_OPEN {
            let path = format!("file-{i}.txt");
            fs::write(root.path().join(&path), "x".repeat(64 * 1024)).unwrap();
            workspace.open(&path).unwrap();
        }
        let before = manifest(state.path());
        let mut revision = workspace.documents["file-0.txt"].revision;
        for _ in 0..20 {
            revision = workspace
                .patch("file-0.txt", revision, 0, 0, "y".into())
                .unwrap()
                .revision;
            let next = manifest(state.path());
            assert!(
                fs::metadata(state.path().join("drafts.json"))
                    .unwrap()
                    .len()
                    < MAX_MANIFEST
            );
            for original in before
                .documents
                .iter()
                .filter(|doc| doc.path != "file-0.txt")
            {
                assert!(
                    next.documents
                        .iter()
                        .any(|doc| doc.path == original.path && doc.record == original.record)
                );
            }
            let records = fs::read_dir(state.path())
                .unwrap()
                .flatten()
                .filter(|entry| record_name(&entry.file_name().to_string_lossy()))
                .count();
            assert!(
                records <= MAX_OPEN + 1,
                "Unchanged records are shared between commits"
            );
            let prior: RecoveryManifest = serde_json::from_slice(
                &fs::read(state.path().join("drafts.previous.json")).unwrap(),
            )
            .unwrap();
            for reference in prior.documents {
                assert!(state.path().join(reference.record).is_file());
            }
        }
    }

    #[test]
    fn missing_or_modified_unchanged_record_is_repaired_before_acknowledgement() {
        for truncate in [false, true] {
            let (root, state, mut workspace) = setup();
            fs::write(root.path().join("second.txt"), "second").unwrap();
            let first = workspace.open("hello.txt").unwrap();
            workspace
                .edit("hello.txt", first.revision, "acknowledged first".into())
                .unwrap();
            let second = workspace.open("second.txt").unwrap();
            let record = manifest(state.path())
                .documents
                .into_iter()
                .find(|doc| doc.path == "hello.txt")
                .unwrap()
                .record;
            if truncate {
                fs::write(state.path().join(&record), b"corrupt").unwrap();
            } else {
                fs::remove_file(state.path().join(&record)).unwrap();
            }
            workspace
                .patch("second.txt", second.revision, 0, 0, "edited ".into())
                .unwrap();
            drop(workspace);
            let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
            assert_eq!(
                recovered.file_snapshot("hello.txt").unwrap().content,
                "acknowledged first"
            );
            assert_eq!(
                recovered.file_snapshot("second.txt").unwrap().content,
                "edited second"
            );
        }
    }

    #[test]
    fn legacy_recovery_migrates_and_record_corruption_is_rejected() {
        let (root, state, workspace) = setup();
        drop(workspace);
        let legacy = serde_json::json!({"version":1,"workspace":fs::canonicalize(root.path()).unwrap(),"active_path":"hello.txt","documents":[{"path":"hello.txt","content":"legacy draft","revision":9,"dirty":true,"conflict":null,"saved_revision":fingerprint(b"hello")}]});
        fs::write(
            state.path().join("drafts.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let mut recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot("hello.txt").unwrap().content,
            "legacy draft"
        );
        recovered
            .patch("hello.txt", 9, 0, 0, "new ".into())
            .unwrap();
        let reference = manifest(state.path()).documents.remove(0);
        drop(recovered);
        fs::write(state.path().join(reference.record), b"tampered").unwrap();
        assert!(Workspace::new(root.path(), Some(state.path().into())).is_err());
    }

    #[test]
    fn repeated_precommit_failures_do_not_accumulate_or_delete_acknowledged_records() {
        let (_root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        let before = fs::read(state.path().join("drafts.json")).unwrap();
        let names = || {
            fs::read_dir(state.path())
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| record_name(name))
                .collect::<BTreeSet<_>>()
        };
        let records = names();
        workspace.fail_prepare.store(true, Ordering::Relaxed);
        for i in 0..20 {
            assert!(
                workspace
                    .edit("hello.txt", opened.revision, format!("unacknowledged-{i}"))
                    .is_err()
            );
            assert_eq!(names(), records);
            assert_eq!(fs::read(state.path().join("drafts.json")).unwrap(), before);
        }
    }

    #[test]
    fn uncertain_commit_stops_mutations_and_recovers_previous_acknowledged_text() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        let acknowledged = workspace
            .edit("hello.txt", opened.revision, "acknowledged".into())
            .unwrap();
        let previous = fs::read(state.path().join("drafts.json")).unwrap();
        workspace.fail_commit_sync.store(true, Ordering::Relaxed);
        assert_eq!(
            workspace
                .patch(
                    "hello.txt",
                    acknowledged.revision,
                    0,
                    0,
                    "not acknowledged ".into()
                )
                .unwrap_err()
                .code,
            "recovery_ambiguous"
        );
        assert!(state.path().join(".recovery-transaction").is_file());
        assert_eq!(
            fs::read(state.path().join("drafts.previous.json")).unwrap(),
            previous
        );
        assert!(workspace.create("blocked.txt", "blocked".into()).is_err());
        assert!(!root.path().join("blocked.txt").exists());
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot("hello.txt").unwrap().content,
            "acknowledged"
        );
        assert!(!state.path().join(".recovery-transaction").exists());
        assert!(state.path().join("drafts.interrupted.json").is_file());
    }

    #[test]
    fn crash_before_manifest_commit_restores_prior_draft() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        workspace
            .edit("hello.txt", opened.revision, "safe prior".into())
            .unwrap();
        drop(workspace);
        fs::remove_file(state.path().join("drafts.previous.json")).unwrap();
        fs::hard_link(
            state.path().join("drafts.json"),
            state.path().join("drafts.previous.json"),
        )
        .unwrap();
        fs::write(
            state.path().join(".recovery-transaction"),
            b"{\"previous\":true}",
        )
        .unwrap();
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot("hello.txt").unwrap().content,
            "safe prior"
        );
    }

    #[test]
    fn linked_manifest_marker_recovers_long_paths_and_older_v2_checkpoints() {
        let (root, state, mut workspace) = setup();
        // Multiple legal filenames make the manifest exceed 1 KiB without
        // exceeding macOS's total path-length limit.
        let paths: Vec<_> = (0..6)
            .map(|i| format!("{i}-{}.txt", "d".repeat(180)))
            .collect();
        for path in &paths {
            fs::write(root.path().join(path), "original").unwrap();
            workspace.open(path).unwrap();
        }
        let path = paths[0].clone();
        let opened = workspace.file_snapshot(&path).unwrap();
        let acknowledged = workspace
            .edit(&path, opened.revision, "last acknowledgement".into())
            .unwrap();
        // Compatibility with the v2 manifests written before the linked marker.
        let mut prior: serde_json::Value =
            serde_json::from_slice(&fs::read(state.path().join("drafts.json")).unwrap()).unwrap();
        prior.as_object_mut().unwrap().remove("previous");
        fs::write(
            state.path().join("drafts.json"),
            serde_json::to_vec(&prior).unwrap(),
        )
        .unwrap();
        drop(workspace);
        let mut workspace = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            workspace.file_snapshot(&path).unwrap().content,
            "last acknowledgement"
        );
        workspace.fail_commit_sync.store(true, Ordering::Relaxed);
        assert_eq!(
            workspace
                .edit(&path, acknowledged.revision, "unacknowledged".into())
                .unwrap_err()
                .code,
            "recovery_ambiguous"
        );
        let bytes = fs::read(state.path().join(".recovery-transaction")).unwrap();
        assert!(bytes.len() > 1024 && bytes.len() <= MAX_MANIFEST as usize);
        assert!(
            serde_json::from_slice::<RecoveryIntent>(&bytes)
                .unwrap()
                .previous
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(state.path().join("drafts.json"))
                    .unwrap()
                    .ino(),
                fs::metadata(state.path().join(".recovery-transaction"))
                    .unwrap()
                    .ino()
            );
        }
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot(&path).unwrap().content,
            "last acknowledgement"
        );
    }

    #[test]
    fn first_linked_manifest_failure_recovers_without_a_prior_checkpoint() {
        let (root, state, mut workspace) = setup();
        workspace.fail_commit_sync.store(true, Ordering::Relaxed);
        assert_eq!(
            workspace.open("hello.txt").unwrap_err().code,
            "recovery_ambiguous"
        );
        let bytes = fs::read(state.path().join(".recovery-transaction")).unwrap();
        assert!(
            !serde_json::from_slice::<RecoveryIntent>(&bytes)
                .unwrap()
                .previous
        );
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert!(recovered.documents.is_empty());
        assert!(!state.path().join(".recovery-transaction").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "hello"
        );
    }

    #[test]
    fn marker_removal_failure_recreates_intent_and_keeps_the_last_acknowledgement() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        let acknowledged = workspace
            .edit("hello.txt", opened.revision, "acknowledged".into())
            .unwrap();
        workspace.fail_finish_sync.store(true, Ordering::Relaxed);
        assert_eq!(
            workspace
                .edit(
                    "hello.txt",
                    acknowledged.revision,
                    "not acknowledged".into()
                )
                .unwrap_err()
                .code,
            "recovery_ambiguous"
        );
        let bytes = fs::read(state.path().join(".recovery-transaction")).unwrap();
        assert!(bytes.len() < 1024);
        assert!(
            serde_json::from_slice::<RecoveryIntent>(&bytes)
                .unwrap()
                .previous
        );
        assert!(
            workspace
                .edit("hello.txt", acknowledged.revision, "blocked".into())
                .is_err()
        );
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(
            recovered.file_snapshot("hello.txt").unwrap().content,
            "acknowledged"
        );
    }

    #[test]
    fn refuses_traversal_and_symlinks() {
        let (root, _, workspace) = setup();
        assert!(workspace.resolve("../hello.txt", false).is_err());
        assert!(workspace.resolve("/etc/passwd", false).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("hello.txt", root.path().join("link")).unwrap();
            assert!(workspace.resolve("link", false).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn named_pipes_cannot_block_document_or_recovery_open() {
        let (root, _state, workspace) = setup();
        let pipe = root.path().join("pipe");
        let name = std::ffi::CString::new(pipe.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let regular = open_regular(&pipe, MAX_RECOVERY).is_ok();
            let document = workspace.read_disk("pipe").is_ok();
            send.send((regular, document)).unwrap();
        });
        let result = receive.recv_timeout(std::time::Duration::from_secs(1));
        if result.is_err() {
            // Release a regressed blocking open before failing the assertion.
            use std::os::unix::fs::OpenOptionsExt;
            let _writer = OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(root.path().join("pipe"));
        }
        assert_eq!(result.unwrap(), (false, false));
        reader.join().unwrap();
    }
    #[test]
    fn revisions_conflicts_and_explicit_resolution() {
        let (root, _state, mut workspace) = setup();
        workspace.open("hello.txt").unwrap();
        let edited = workspace
            .edit("hello.txt", 1, "my unsaved work".into())
            .unwrap();
        assert!(workspace.edit("hello.txt", 1, "stale".into()).is_err());
        fs::write(root.path().join("hello.txt"), "external work").unwrap();
        let changed = workspace.refresh().unwrap();
        assert_eq!(changed[0].content, "my unsaved work");
        assert_eq!(
            workspace
                .save("hello.txt", edited.revision)
                .unwrap_err()
                .code,
            "disk_conflict"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "external work"
        );
        let conflict = changed[0].conflict.as_ref().unwrap();
        workspace
            .resolve_conflict(
                "hello.txt",
                edited.revision,
                &conflict.disk_revision,
                "buffer",
            )
            .unwrap();
        workspace.save("hello.txt", edited.revision).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "my unsaved work"
        );
    }
    #[test]
    fn recovers_acknowledged_unsaved_edits() {
        let (root, state, mut workspace) = setup();
        workspace.open("hello.txt").unwrap();
        workspace
            .edit("hello.txt", 1, "draft after restart".into())
            .unwrap();
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(recovered.documents()[0].content, "draft after restart");
        assert!(recovered.documents()[0].dirty);
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "hello"
        );
    }
    #[test]
    fn revisions_advance_across_files_close_reopen_and_recovery() {
        let (root, state, mut workspace) = setup();
        fs::write(root.path().join("second.txt"), "second").unwrap();
        let first = workspace.open("hello.txt").unwrap();
        let second = workspace.open("second.txt").unwrap();
        assert!(second.revision > first.revision);
        let edited = workspace
            .edit("hello.txt", first.revision, "draft".into())
            .unwrap();
        assert!(edited.revision > second.revision);
        workspace.close("second.txt", false).unwrap();
        let reopened = workspace.open("second.txt").unwrap();
        assert!(reopened.revision > edited.revision);
        assert_eq!(
            workspace
                .edit("second.txt", second.revision, "delayed".into())
                .unwrap_err()
                .code,
            "stale_revision"
        );
        let undone = workspace.undo("hello.txt", edited.revision, false).unwrap();
        assert!(undone.revision > reopened.revision);
        drop(workspace);
        let mut recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        let restored = recovered.document("hello.txt").unwrap();
        assert_eq!(restored.revision, undone.revision);
        assert!(recovered.document("second.txt").is_err());
        let second = recovered.open_selected("second.txt").unwrap();
        assert!(second.revision > reopened.revision);
        let redone = recovered
            .edit("second.txt", second.revision, "new draft".into())
            .unwrap();
        assert!(redone.revision > restored.revision);
        recovered.close("hello.txt", false).unwrap();
        assert!(recovered.open("hello.txt").unwrap().revision > redone.revision);
    }
    #[test]
    fn lazy_switch_releases_unedited_text_but_keeps_bounded_shortcuts() {
        let (root, state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let text = Arc::downgrade(&workspace.documents["hello.txt"].content.0);
        drop(first);
        for index in 0..MAX_RECENT_FILES + 8 {
            let path = format!("file-{index}.txt");
            fs::write(root.path().join(&path), "x".repeat(32 * 1024)).unwrap();
            workspace.open_selected(&path).unwrap();
            assert_eq!(workspace.usage(), (1, 32 * 1024, 0));
        }
        assert!(
            text.upgrade().is_none(),
            "inactive source allocation released"
        );
        assert_eq!(workspace.recent_files().len(), MAX_RECENT_FILES);
        assert_eq!(workspace.recent_files()[0], "file-39.txt");
        let manifest = manifest(state.path());
        assert_eq!(manifest.documents.len(), 1);
        assert_eq!(manifest.recent_paths.len(), MAX_RECENT_FILES);
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(recovered.usage(), (1, 32 * 1024, 0));
        assert_eq!(recovered.recent_files()[0], "file-39.txt");
    }

    #[test]
    fn lazy_reopen_reads_external_changes_and_rejects_delayed_revisions() {
        let (root, state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        fs::write(root.path().join("hello.txt"), "external").unwrap();
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert_eq!(reopened.content, "external");
        assert!(reopened.revision > first.revision);
        assert_eq!(
            workspace
                .edit("hello.txt", first.revision, "stale".into())
                .unwrap_err()
                .code,
            "stale_revision"
        );
        workspace.open_selected("second.txt").unwrap();
        drop(workspace);
        let mut recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        let again = recovered.open_selected("hello.txt").unwrap();
        assert!(again.revision > reopened.revision);
        assert_eq!(again.content, "external");
    }

    #[test]
    fn lazy_switch_preserves_dirty_history_conflicts_and_restart_recovery() {
        let (root, state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let edited = workspace
            .edit("hello.txt", first.revision, "unsaved".into())
            .unwrap();
        fs::write(root.path().join("hello.txt"), "external").unwrap();
        workspace.refresh().unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        assert_eq!(workspace.documents["hello.txt"].undo.len(), 1);
        assert!(workspace.documents["hello.txt"].conflict.is_some());
        assert_eq!(workspace.documents["hello.txt"].content, "unsaved");
        assert_eq!(
            workspace.document("hello.txt").unwrap().revision,
            edited.revision
        );
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(recovered.usage().0, 2);
        assert_eq!(recovered.documents["hello.txt"].content, "unsaved");
        assert_eq!(
            recovered.documents["hello.txt"]
                .conflict
                .as_ref()
                .unwrap()
                .disk_content
                .as_deref(),
            Some("external")
        );
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "external"
        );
    }

    #[test]
    fn failed_lazy_activation_keeps_active_buffer_history_and_shortcuts() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open_selected("hello.txt").unwrap();
        let edited = workspace
            .edit("hello.txt", opened.revision, "saved".into())
            .unwrap();
        workspace.save("hello.txt", edited.revision).unwrap();
        fs::write(root.path().join("second.txt"), "second").unwrap();
        let before = fs::read(state.path().join("drafts.json")).unwrap();
        workspace.fail_prepare.store(true, Ordering::Relaxed);
        assert!(workspace.open_selected("second.txt").is_err());
        assert_eq!(workspace.active_path.as_deref(), Some("hello.txt"));
        assert_eq!(workspace.documents["hello.txt"].content, "saved");
        assert_eq!(workspace.documents["hello.txt"].undo.len(), 1);
        assert_eq!(workspace.recent_files(), &["hello.txt"]);
        assert_eq!(fs::read(state.path().join("drafts.json")).unwrap(), before);
        workspace.fail_prepare.store(false, Ordering::Relaxed);
        assert!(workspace.open_selected("missing.txt").is_err());
        assert_eq!(workspace.usage().0, 1);
        assert_eq!(workspace.active_path.as_deref(), Some("hello.txt"));
    }

    #[test]
    fn lazy_activation_can_replace_eighth_clean_buffer_but_never_evicts_eight_drafts() {
        let (root, _state, mut workspace) = setup();
        for index in 0..MAX_OPEN - 1 {
            let path = format!("draft-{index}.txt");
            let opened = workspace.create_selected(&path, "saved".into()).unwrap();
            workspace
                .edit(&path, opened.revision, "unsaved".into())
                .unwrap();
        }
        workspace.open_selected("hello.txt").unwrap();
        assert_eq!(workspace.usage().0, MAX_OPEN);
        let last = workspace
            .create_selected("last.txt", "last".into())
            .unwrap();
        assert_eq!(workspace.usage().0, MAX_OPEN);
        assert!(workspace.document("hello.txt").is_err());
        workspace
            .edit("last.txt", last.revision, "eighth draft".into())
            .unwrap();
        fs::write(root.path().join("new.txt"), "new").unwrap();
        assert_eq!(
            workspace.open_selected("new.txt").unwrap_err().code,
            "limit"
        );
        assert_eq!(
            workspace
                .create_selected("no-create.txt", "new".into())
                .unwrap_err()
                .code,
            "limit"
        );
        assert!(!root.path().join("no-create.txt").exists());
        assert_eq!(workspace.usage().0, MAX_OPEN);
        assert!(workspace.documents.values().all(|document| document.dirty));
    }

    #[test]
    fn missing_shortcut_does_not_replace_current_file_and_can_be_forgotten_without_read() {
        let (root, state, mut workspace) = setup();
        workspace.open_selected("hello.txt").unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        fs::remove_file(root.path().join("hello.txt")).unwrap();
        assert!(workspace.select("hello.txt").is_err());
        assert_eq!(workspace.active_path.as_deref(), Some("second.txt"));
        assert!(workspace.recent_files().contains(&"hello.txt".into()));
        let reads = workspace.disk_reads.load(Ordering::Relaxed);
        workspace.close("hello.txt", false).unwrap();
        assert_eq!(workspace.disk_reads.load(Ordering::Relaxed), reads);
        assert!(!workspace.recent_files().contains(&"hello.txt".into()));
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(recovered.recent_files(), &["second.txt"]);
    }

    #[test]
    fn old_dirty_file_becomes_a_shortcut_after_saving_and_keeps_its_history() {
        let (root, _state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let edited = workspace
            .edit("hello.txt", first.revision, "unsaved".into())
            .unwrap();
        for index in 0..MAX_RECENT_FILES + 1 {
            let path = format!("clean-{index}.txt");
            fs::write(root.path().join(&path), "clean").unwrap();
            workspace.open_selected(&path).unwrap();
        }
        assert!(!workspace.recent_files().contains(&"hello.txt".into()));
        assert_eq!(workspace.documents["hello.txt"].undo.len(), 1);
        workspace.save("hello.txt", edited.revision).unwrap();
        workspace.release_saved_inactive().unwrap();
        assert_eq!(workspace.usage(), (1, 5, 5));
        assert!(workspace.recent_files().contains(&"hello.txt".into()));
        assert_eq!(workspace.recent_files()[0], "clean-32.txt");
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "unsaved"
        );
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert_eq!(
            workspace
                .undo("hello.txt", reopened.revision, false)
                .unwrap()
                .content,
            "hello"
        );
    }

    #[test]
    fn saved_file_switch_preserves_both_undo_and_redo_without_loaded_source() {
        let (_root, _state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let saved = workspace
            .edit("hello.txt", first.revision, "saved".into())
            .unwrap();
        workspace.save("hello.txt", saved.revision).unwrap();
        let changed = workspace
            .edit("hello.txt", saved.revision, "next".into())
            .unwrap();
        workspace
            .undo("hello.txt", changed.revision, false)
            .unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        assert!(workspace.document("hello.txt").is_err());
        assert_eq!(workspace.usage(), (1, 6, 9));
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert!(workspace.saved_histories.is_empty());
        let undone = workspace
            .undo("hello.txt", reopened.revision, false)
            .unwrap();
        assert_eq!(undone.content, "hello");
        let redone = workspace.undo("hello.txt", undone.revision, true).unwrap();
        assert_eq!(redone.content, "saved");
        assert!(!redone.dirty);
        assert_eq!(
            workspace
                .undo("hello.txt", redone.revision, true)
                .unwrap()
                .content,
            "next"
        );
    }

    #[test]
    fn unloaded_history_is_invalidated_by_external_disk_changes_and_explicit_close() {
        let (root, _state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let saved = workspace
            .edit("hello.txt", first.revision, "saved".into())
            .unwrap();
        workspace.save("hello.txt", saved.revision).unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        fs::write(root.path().join("hello.txt"), "external").unwrap();
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert_eq!(reopened.content, "external");
        assert_eq!(
            workspace
                .undo("hello.txt", reopened.revision, false)
                .unwrap_err()
                .code,
            "history"
        );
        let saved = workspace
            .edit("hello.txt", reopened.revision, "saved again".into())
            .unwrap();
        workspace.save("hello.txt", saved.revision).unwrap();
        workspace.open_selected("second.txt").unwrap();
        assert!(workspace.saved_histories.contains_key("hello.txt"));
        workspace.close("hello.txt", false).unwrap();
        assert_eq!(workspace.usage().2, 0);
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert_eq!(
            workspace
                .undo("hello.txt", reopened.revision, false)
                .unwrap_err()
                .code,
            "history"
        );
    }

    #[test]
    fn unloaded_history_obeys_byte_and_recent_path_budgets() {
        let (root, _state, mut workspace) = setup();
        workspace.session_budget(MAX_OPEN, 12);
        for index in 0..MAX_RECENT_FILES + 8 {
            let path = format!("edited-{index}.txt");
            fs::write(root.path().join(&path), "hello").unwrap();
            let opened = workspace.open_selected(&path).unwrap();
            let edited = workspace
                .edit(&path, opened.revision, "saved".into())
                .unwrap();
            workspace.save(&path, edited.revision).unwrap();
            assert_eq!(workspace.usage().0, 1);
            assert!(workspace.usage().2 <= 12);
            assert!(workspace.saved_histories.len() <= MAX_RECENT_FILES);
        }
        assert!(!workspace.saved_histories.contains_key("edited-0.txt"));
        assert!(workspace.saved_histories.contains_key("edited-38.txt"));
        let reopened = workspace.open_selected("edited-38.txt").unwrap();
        assert_eq!(
            workspace
                .undo("edited-38.txt", reopened.revision, false)
                .unwrap()
                .content,
            "hello"
        );
    }

    #[test]
    fn failed_reopen_and_close_keep_unloaded_history_and_active_file() {
        let (_root, _state, mut workspace) = setup();
        let first = workspace.open_selected("hello.txt").unwrap();
        let saved = workspace
            .edit("hello.txt", first.revision, "saved".into())
            .unwrap();
        workspace.save("hello.txt", saved.revision).unwrap();
        workspace
            .create_selected("second.txt", "second".into())
            .unwrap();
        workspace.fail_prepare.store(true, Ordering::Relaxed);
        assert!(workspace.open_selected("hello.txt").is_err());
        assert!(workspace.close("hello.txt", false).is_err());
        assert_eq!(workspace.active_path.as_deref(), Some("second.txt"));
        assert_eq!(workspace.usage(), (1, 6, 5));
        workspace.fail_prepare.store(false, Ordering::Relaxed);
        let reopened = workspace.open_selected("hello.txt").unwrap();
        assert_eq!(
            workspace
                .undo("hello.txt", reopened.revision, false)
                .unwrap()
                .content,
            "hello"
        );
    }
    #[test]
    fn borrowed_document_view_preserves_missing_disk_conflicts_without_history_copies() {
        let (root, _state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        workspace
            .edit("hello.txt", opened.revision, "preserved".into())
            .unwrap();
        fs::remove_file(root.path().join("hello.txt")).unwrap();
        workspace.refresh().unwrap();
        let document = workspace.document("hello.txt").unwrap();
        assert_eq!(document.content, "preserved");
        assert!(document.conflict.as_ref().unwrap().disk_content.is_none());
        assert!(document.undo.is_empty());
        assert!(document.redo.is_empty());
        assert_eq!(
            workspace.document("missing.txt").unwrap_err().code,
            "not_open"
        );
    }
    #[test]
    fn bounded_history_and_unsaved_close() {
        let (_root, _state, mut workspace) = setup();
        workspace.open("hello.txt").unwrap();
        workspace.edit("hello.txt", 1, "edited".into()).unwrap();
        assert_eq!(
            workspace.close("hello.txt", false).unwrap_err().code,
            "unsaved"
        );
        let undone = workspace.undo("hello.txt", 2, false).unwrap();
        assert_eq!(undone.content, "hello");
        assert!(!undone.dirty);
        workspace.close("hello.txt", false).unwrap();
    }

    #[test]
    fn newest_large_file_keeps_immediate_undo_with_other_files_history_at_the_byte_cap() {
        let (root, _state, mut workspace) = setup();
        for path in ["y-older.txt", "z-older.txt"] {
            let text = "o".repeat(900_000);
            fs::write(root.path().join(path), &text).unwrap();
            let opened = workspace.open(path).unwrap();
            workspace
                .edit(path, opened.revision, format!("{text}Z"))
                .unwrap();
        }
        assert!(workspace.usage().2 <= MAX_HISTORY);
        let text = "n".repeat(980_000);
        fs::write(root.path().join("a-new.txt"), &text).unwrap();
        let opened = workspace.open("a-new.txt").unwrap();
        let after = format!("{text}X");
        let edited = workspace
            .edit("a-new.txt", opened.revision, after.clone())
            .unwrap();
        assert!(workspace.usage().2 <= MAX_HISTORY);
        let undone = workspace.undo("a-new.txt", edited.revision, false).unwrap();
        assert_eq!(undone.content, text);
        assert!(workspace.usage().2 <= MAX_HISTORY);
        let redone = workspace.undo("a-new.txt", undone.revision, true).unwrap();
        assert_eq!(redone.content, after);
        assert!(workspace.usage().2 <= MAX_HISTORY);
    }

    #[test]
    fn protected_history_still_obeys_entry_and_byte_limits() {
        let (_root, _state, mut workspace) = setup();
        let mut file = workspace.open("hello.txt").unwrap();
        for number in 0..30 {
            file = workspace
                .edit("hello.txt", file.revision, format!("edit {number}"))
                .unwrap();
        }
        assert!(workspace.documents["hello.txt"].undo.len() <= 20);
        assert!(workspace.usage().2 <= MAX_HISTORY);
        workspace.session_budget(MAX_OPEN, 3);
        file = workspace
            .edit("hello.txt", file.revision, "latest edit".into())
            .unwrap();
        assert!(workspace.usage().2 <= 3);
        assert_eq!(workspace.documents["hello.txt"].content, "latest edit");
        assert_eq!(
            workspace
                .undo("hello.txt", file.revision, false)
                .unwrap_err()
                .code,
            "history"
        );
    }
    #[test]
    fn refuses_two_hosts_for_the_same_recovery() {
        let (root, state, _workspace) = setup();
        assert!(Workspace::new(root.path(), Some(state.path().into())).is_err());
    }

    #[test]
    fn project_name_search_finds_nested_duplicates_unicode_and_directories() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        for directory in ["src", "docs"] {
            fs::create_dir(root.path().join(directory)).unwrap();
            fs::write(
                root.path().join(directory).join("Überblick.md"),
                "private contents",
            )
            .unwrap();
        }
        fs::write(root.path().join("literal[1].md"), "not searched").unwrap();
        fs::write(root.path().join("build"), "project script").unwrap();
        let (scripts, truncated) = search_root(&root_path, "build").unwrap();
        assert!(!truncated);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].path, "build");
        assert!(!scripts[0].directory);
        let (files, truncated) = search_root(&root_path, "ÜBERBLICK").unwrap();
        assert!(!truncated);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "docs/Überblick.md");
        assert_eq!(files[1].path, "src/Überblick.md");
        assert!(files.iter().all(|file| !file.directory));
        assert_eq!(search_root(&root_path, "[1]").unwrap().0.len(), 1);
        let (directories, _) = search_root(&root_path, "sr").unwrap();
        assert_eq!(directories.len(), 1);
        assert!(directories[0].directory);
        assert_eq!(directories[0].path, "src");
        assert!(
            search_root(&root_path, "private contents")
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn project_name_search_has_result_traversal_depth_and_query_limits() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        for index in 0..MAX_SEARCH_RESULTS + 1 {
            fs::write(root.path().join(format!("match-{index}.txt")), "").unwrap();
        }
        let (files, truncated) = search_root(&root_path, "match-").unwrap();
        assert_eq!(files.len(), MAX_SEARCH_RESULTS);
        assert!(truncated);
        let page = search_root_bounded(&root_path, "match-", None, 3, 32).unwrap();
        assert_eq!(page.files.len(), 3);
        assert!(page.cursor.is_some());
        fs::create_dir_all(root.path().join("a/b/c")).unwrap();
        fs::write(root.path().join("a/b/c/deep.txt"), "").unwrap();
        let page = search_root_bounded(&root_path, "deep", None, 20_000, 1).unwrap();
        assert!(page.files.is_empty());
        assert!(page.truncated);
        for query in [
            "".into(),
            " ".into(),
            "../outside".into(),
            "a\\b".into(),
            "a\0b".into(),
            "日".repeat(129),
        ] {
            assert_eq!(search_root(&root_path, &query).unwrap_err().code, "query");
        }
        assert!(search_root(&root_path, &"日".repeat(128)).is_ok());
    }

    #[test]
    fn project_name_search_skips_generated_folders_symlinks_and_outside_files() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("needle-outside.txt"), "secret").unwrap();
        fs::write(root.path().join("needle-visible.txt"), "").unwrap();
        for directory in [".git", "node_modules", "target", "build", "dist", ".nimlo"] {
            fs::create_dir(root.path().join(directory)).unwrap();
            fs::write(root.path().join(directory).join("needle-hidden.txt"), "").unwrap();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("needle-linked-dir"))
                .unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("needle-outside.txt"),
                root.path().join("needle-linked-file"),
            )
            .unwrap();
            std::os::unix::fs::symlink(root.path(), root.path().join("needle-cycle")).unwrap();
        }
        let (files, truncated) = search_root(&root_path, "needle").unwrap();
        assert!(!truncated);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "needle-visible.txt");
    }

    #[test]
    fn project_name_search_resumes_batches_without_losing_nested_files() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        let expected: BTreeSet<_> = (0..9)
            .map(|index| format!("docs/folder-{index}/logo-v03-master-prompt.txt"))
            .collect();
        for path in &expected {
            let path = root.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "not searched").unwrap();
        }
        let mut cursor = None;
        let mut found = BTreeSet::new();
        let mut batches = 0;
        loop {
            let page = search_root_bounded(&root_path, "logo-v03", cursor, 3, 32).unwrap();
            assert!(!page.truncated);
            for file in page.files {
                assert!(found.insert(file.path));
            }
            batches += 1;
            cursor = page.cursor;
            if cursor.is_none() {
                break;
            }
            // The wire representation is sufficient to continue the scan.
            cursor = serde_json::from_value(serde_json::to_value(cursor).unwrap()).unwrap();
            assert!(batches < 20);
        }
        assert!(batches > 1);
        assert_eq!(found, expected);
    }

    #[test]
    fn project_name_search_keeps_best_matches_after_the_result_limit() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        for index in 0..100 {
            fs::write(root.path().join(format!("prefix-needle-{index}.txt")), "").unwrap();
        }
        fs::write(root.path().join("needle.txt"), "").unwrap();
        let page = search_root_page(&root_path, "needle", None).unwrap();
        assert_eq!(page.files.len(), MAX_SEARCH_RESULTS);
        assert_eq!(page.files[0].name, "needle.txt");
        assert!(page.truncated);
        assert!(page.cursor.is_none());
    }

    #[test]
    fn project_name_search_rejects_foreign_queries_and_cursor_traversal() {
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        fs::write(root.path().join("needle.txt"), "").unwrap();
        let cursor = search_root_bounded(&root_path, "needle", None, 1, 32)
            .unwrap()
            .cursor;
        assert!(cursor.is_some());
        assert!(search_root_page(&root_path, "other", cursor).is_err());
        let cursor = SearchCursor {
            query: "needle".into(),
            frames: vec![
                SearchFrame {
                    directory: String::new(),
                    offset: 0,
                },
                SearchFrame {
                    directory: "..".into(),
                    offset: 0,
                },
            ],
            incomplete: false,
        };
        assert!(search_root_page(&root_path, "needle", Some(cursor)).is_err());
    }

    #[test]
    fn creates_files_without_overwriting_or_traversing() {
        let (root, _state, mut workspace) = setup();
        let created = workspace.create("new.rs", "fn main() {}\n".into()).unwrap();
        assert_eq!(created.content, "fn main() {}\n");
        assert!(!created.dirty);
        assert_eq!(
            workspace
                .create("hello.txt", "replacement".into())
                .unwrap_err()
                .code,
            "exists"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "hello"
        );
        assert!(workspace.create("../outside.txt", String::new()).is_err());
        assert!(workspace.create("./alias.txt", String::new()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path(), root.path().join("linked-dir")).unwrap();
            assert!(
                workspace
                    .create("linked-dir/escape.txt", String::new())
                    .is_err()
            );
        }
    }

    #[test]
    fn rejects_large_binary_and_excess_open_files() {
        let (root, _state, mut workspace) = setup();
        fs::write(root.path().join("large"), vec![b'x'; MAX_FILE + 1]).unwrap();
        assert_eq!(workspace.open("large").unwrap_err().code, "limit");
        fs::write(root.path().join("binary"), b"a\0b").unwrap();
        assert_eq!(workspace.open("binary").unwrap_err().code, "encoding");
        for index in 0..MAX_OPEN {
            workspace
                .create(&format!("file{index}"), String::new())
                .unwrap();
        }
        assert_eq!(workspace.open("hello.txt").unwrap_err().code, "limit");
        assert_eq!(workspace.documents().len(), MAX_OPEN);
    }

    #[test]
    fn recovery_preserves_both_sides_of_a_disk_conflict() {
        let (root, state, mut workspace) = setup();
        workspace.open("hello.txt").unwrap();
        workspace
            .edit("hello.txt", 1, "unsaved draft".into())
            .unwrap();
        fs::write(root.path().join("hello.txt"), "changed externally").unwrap();
        drop(workspace);
        let workspace = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        let recovered = workspace.documents().pop().unwrap();
        assert_eq!(recovered.content, "unsaved draft");
        assert_eq!(
            recovered.conflict.unwrap().disk_content.as_deref(),
            Some("changed externally")
        );
    }

    #[test]
    fn unchanged_refresh_uses_metadata_without_reading_or_copying_buffers() {
        let (root, _state, mut workspace) = setup();
        workspace.open("hello.txt").unwrap();
        let reads = workspace
            .disk_reads
            .load(std::sync::atomic::Ordering::Relaxed);
        let buffer_address = workspace.documents["hello.txt"].content.as_ptr();
        for _ in 0..10 {
            assert!(workspace.refresh().unwrap().is_empty());
        }
        assert_eq!(
            workspace
                .disk_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            reads
        );
        assert_eq!(
            workspace.documents["hello.txt"].content.as_ptr(),
            buffer_address
        );
        fs::write(root.path().join("hello.txt"), "disk changed").unwrap();
        let changed = workspace.refresh().unwrap();
        assert_eq!(changed[0].content, "disk changed");
        assert_eq!(
            workspace
                .disk_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            reads + 1
        );
        assert!(workspace.refresh().unwrap().is_empty());
    }

    #[test]
    fn document_views_history_and_conflicts_share_immutable_text_with_unchanged_json() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        assert!(Arc::ptr_eq(
            &opened.content.0,
            &workspace.documents["hello.txt"].content.0
        ));
        let input = "draft \"quoted\"\n雪".repeat(4096);
        let input_address = input.as_ptr();
        let edited = workspace.edit("hello.txt", opened.revision, input).unwrap();
        assert_eq!(edited.content.as_ptr(), input_address);
        assert_eq!(opened.content, "hello");
        let snapshot = workspace.documents["hello.txt"].clone();
        assert!(Arc::ptr_eq(&snapshot.content.0, &edited.content.0));
        assert!(Arc::ptr_eq(&snapshot.undo[0].0, &opened.content.0));

        fs::write(root.path().join("hello.txt"), "external \"disk\"\n雪").unwrap();
        let changed = workspace.refresh().unwrap().pop().unwrap();
        let disk = changed
            .conflict
            .as_ref()
            .unwrap()
            .disk_content
            .as_ref()
            .unwrap();
        assert!(Arc::ptr_eq(
            &disk.0,
            &workspace.documents["hello.txt"]
                .conflict
                .as_ref()
                .unwrap()
                .disk_content
                .as_ref()
                .unwrap()
                .0
        ));
        let wire = serde_json::to_value(&changed).unwrap();
        assert_eq!(wire["content"], edited.content.as_ref());
        assert_eq!(wire["conflict"]["diskContent"], "external \"disk\"\n雪");
        assert_eq!(wire.as_object().unwrap().len(), 5);
        assert!(wire.get("undo").is_none());
        assert!(wire.get("saved_revision").is_none());
        let recovery: RecoveryManifest =
            serde_json::from_slice(&fs::read(state.path().join("drafts.json")).unwrap()).unwrap();
        let restored: Document = serde_json::from_slice(
            &fs::read(state.path().join(&recovery.documents[0].record)).unwrap(),
        )
        .unwrap();
        assert_eq!(restored.content, changed.content);
        assert_eq!(restored.conflict.unwrap().disk_content.unwrap(), *disk);

        let undone = workspace.undo("hello.txt", edited.revision, false).unwrap();
        assert!(Arc::ptr_eq(&undone.content.0, &opened.content.0));
        let redone = workspace.undo("hello.txt", undone.revision, true).unwrap();
        assert!(Arc::ptr_eq(&redone.content.0, &edited.content.0));
    }

    #[test]
    fn failed_document_changes_preserve_all_history_and_the_checkpoint() {
        let (root, state, mut workspace) = setup();
        fs::write(root.path().join("second.txt"), "x").unwrap();
        let first = workspace.open("hello.txt").unwrap();
        workspace
            .edit("hello.txt", first.revision, "aaaaa".into())
            .unwrap();
        let second = workspace.open("second.txt").unwrap();
        let second = workspace
            .edit("second.txt", second.revision, "yyyyy".into())
            .unwrap();
        workspace.session_budget(MAX_OPEN, 6);
        assert_eq!(workspace.usage().2, 6);
        let first_history = workspace.documents["hello.txt"].undo[0].clone();
        let before = workspace.documents["second.txt"].clone();
        let checkpoint = fs::read(state.path().join("drafts.json")).unwrap();
        workspace.state_dir = state.path().join("missing");
        assert!(
            workspace
                .edit("second.txt", second.revision, "z".into())
                .is_err()
        );
        assert!(
            workspace
                .undo("second.txt", second.revision, false)
                .is_err()
        );
        assert_eq!(workspace.usage().2, 6);
        assert!(Arc::ptr_eq(
            &workspace.documents["hello.txt"].undo[0].0,
            &first_history.0
        ));
        let current = &workspace.documents["second.txt"];
        assert_eq!(current.revision, before.revision);
        assert!(Arc::ptr_eq(&current.content.0, &before.content.0));
        assert!(Arc::ptr_eq(&current.undo[0].0, &before.undo[0].0));
        assert!(current.redo.is_empty());
        assert_eq!(
            fs::read(state.path().join("drafts.json")).unwrap(),
            checkpoint
        );

        workspace.state_dir = state.path().to_owned();
        fs::write(root.path().join("second.txt"), "disk!").unwrap();
        let conflict = workspace.refresh().unwrap().pop().unwrap();
        let disk_revision = &conflict.conflict.as_ref().unwrap().disk_revision;
        let checkpoint = fs::read(state.path().join("drafts.json")).unwrap();
        workspace.state_dir = state.path().join("missing");
        assert!(
            workspace
                .resolve_conflict("second.txt", second.revision, disk_revision, "disk")
                .is_err()
        );
        assert_eq!(workspace.usage().2, 6);
        assert!(Arc::ptr_eq(
            &workspace.documents["hello.txt"].undo[0].0,
            &first_history.0
        ));
        assert_eq!(workspace.documents["second.txt"].content, "yyyyy");
        assert_eq!(
            workspace.documents["second.txt"]
                .conflict
                .as_ref()
                .unwrap()
                .disk_revision,
            *disk_revision
        );
        assert_eq!(
            fs::read(state.path().join("drafts.json")).unwrap(),
            checkpoint
        );
    }

    #[test]
    fn failed_refresh_restores_every_buffer_and_retries_after_checkpoint_repair() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        let before = workspace.documents["hello.txt"].clone();
        let checkpoint = fs::read(state.path().join("drafts.json")).unwrap();
        fs::write(root.path().join("hello.txt"), "external change").unwrap();
        workspace.state_dir = state.path().join("missing");
        assert!(workspace.refresh().is_err());
        let current = &workspace.documents["hello.txt"];
        assert!(Arc::ptr_eq(&current.content.0, &before.content.0));
        assert_eq!(current.revision, opened.revision);
        assert_eq!(current.disk_observation, before.disk_observation);
        assert!(current.undo.is_empty());
        assert_eq!(
            fs::read(state.path().join("drafts.json")).unwrap(),
            checkpoint
        );
        workspace.state_dir = state.path().to_owned();
        let changed = workspace.refresh().unwrap();
        assert_eq!(changed[0].content, "external change");
        assert_eq!(
            workspace
                .undo("hello.txt", changed[0].revision, false)
                .unwrap()
                .content,
            "hello"
        );
    }

    #[test]
    fn failed_save_checkpoint_retains_the_draft_until_disk_reconciliation() {
        let (root, state, mut workspace) = setup();
        let opened = workspace.open("hello.txt").unwrap();
        let draft = workspace
            .edit("hello.txt", opened.revision, "saved draft".into())
            .unwrap();
        let saved_revision = workspace.documents["hello.txt"].saved_revision.clone();
        let checkpoint = fs::read(state.path().join("drafts.json")).unwrap();
        workspace.state_dir = state.path().join("missing");
        assert!(workspace.save("hello.txt", draft.revision).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("hello.txt")).unwrap(),
            "saved draft"
        );
        let current = &workspace.documents["hello.txt"];
        assert!(current.dirty);
        assert_eq!(current.saved_revision, saved_revision);
        assert!(Arc::ptr_eq(&current.content.0, &draft.content.0));
        assert_eq!(
            fs::read(state.path().join("drafts.json")).unwrap(),
            checkpoint
        );
        workspace.state_dir = state.path().to_owned();
        assert!(!workspace.refresh().unwrap()[0].dirty);
        drop(workspace);
        let recovered = Workspace::new(root.path(), Some(state.path().into())).unwrap();
        assert_eq!(recovered.documents["hello.txt"].content, "saved draft");
        assert!(!recovered.documents["hello.txt"].dirty);
    }
}
