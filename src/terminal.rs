//! One host-owned PTY, independent of browser attachment and visibility.
//!
//! `vt100` owns both screen buffers and a 200-row history. It handles the
//! ANSI/DEC screen, Unicode cells and input modes; this is a VT100-compatible
//! subset, not complete xterm emulation. OSC/DCS/APC/PM strings (including
//! clipboard, hyperlinks and graphics) are discarded without being buffered.
//! Only bounded CSI/ESC sequences reach the emulator. Device status and
//! attributes queries receive host replies. No output transcript is retained.

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tokio::sync::watch;

pub const MAX_COLS: u16 = 200;
pub const MAX_ROWS: u16 = 80;
pub const SCROLLBACK_ROWS: usize = 200;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
const READ_BYTES: usize = 8192;
const MAX_CONTROL_BYTES: usize = 1024;
const MAX_REPLY_BYTES: usize = 1024;
const MAX_INPUT_CHUNKS: usize = 64;

#[derive(Clone, Debug, Serialize)]
pub struct TerminalSnapshot {
    pub cols: u16,
    pub rows: u16,
    pub lines: Vec<TerminalLine>,
    pub cursor: TerminalCursor,
    pub running: bool,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub application_keypad: bool,
    pub alternate_screen: bool,
    pub version: u64,
}

impl TerminalSnapshot {
    /// An unstarted project's terminal has no parser, scrollback, or process.
    pub fn idle() -> Self {
        Self {
            cols: 80,
            rows: 24,
            lines: Vec::new(),
            cursor: TerminalCursor {
                row: 0,
                col: 0,
                visible: false,
            },
            running: false,
            bracketed_paste: false,
            application_cursor: false,
            application_keypad: false,
            alternate_screen: false,
            version: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TerminalLine {
    pub runs: Vec<TerminalRun>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TerminalCursor {
    pub row: u16,
    pub col: u16,
    pub visible: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct TerminalRun {
    pub text: String,
    /// Logical cell position/width, including wide characters. UTF-8 byte or
    /// JavaScript string lengths are not terminal cell widths.
    pub col: u16,
    pub cols: u16,
    pub fg: Option<String>,
    pub bg: Option<String>,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Default)]
struct Replies(Vec<u8>);

impl vt100::Callbacks for Replies {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        params: &[&[u16]],
        command: char,
    ) {
        let parameter = params.first().and_then(|p| p.first()).copied().unwrap_or(0);
        let reply = match (i1, command, parameter) {
            (None, 'n', 5) => "\x1b[0n".to_owned(),
            (None | Some(b'?'), 'n', 6) => {
                let (row, col) = screen.cursor_position();
                let prefix = if i1 == Some(b'?') { "?" } else { "" };
                format!("\x1b[{prefix}{};{}R", row + 1, col + 1)
            }
            // VT102 with advanced video attributes. Do not claim graphics,
            // clipboard, mouse protocols or modern xterm extensions.
            (None, 'c', 0) => "\x1b[?1;2c".to_owned(),
            _ => return,
        };
        if self.0.len() + reply.len() <= MAX_REPLY_BYTES {
            self.0.extend_from_slice(reply.as_bytes());
        }
    }

    fn unhandled_escape(
        &mut self,
        _screen: &mut vt100::Screen,
        i1: Option<u8>,
        _i2: Option<u8>,
        command: u8,
    ) {
        if i1.is_none() && command == b'Z' && self.0.len() + 7 <= MAX_REPLY_BYTES {
            self.0.extend_from_slice(b"\x1b[?1;2c");
        }
    }
}

#[derive(Default)]
enum ControlState {
    #[default]
    Ground,
    Escape,
    Csi,
    String {
        escaped: bool,
    },
}

/// Streaming filter with fixed-size sequence storage. In particular an
/// unterminated megabyte OSC never reaches vte's variable-size OSC buffer.
#[derive(Default)]
struct ControlFilter {
    state: ControlState,
    pending: Vec<u8>,
    overflow: bool,
}

impl ControlFilter {
    fn process(&mut self, bytes: &[u8], parser: &mut vt100::Parser<Replies>) -> bool {
        // At most one read chunk plus a previously bounded control sequence.
        let mut accepted = Vec::with_capacity(bytes.len() + MAX_CONTROL_BYTES);
        for &byte in bytes {
            match &mut self.state {
                ControlState::Ground => {
                    if byte == 0x1b {
                        self.begin_escape();
                    } else {
                        accepted.push(byte);
                    }
                }
                ControlState::Escape => match byte {
                    0x1b => self.begin_escape(),
                    b']' | b'P' | b'_' | b'^' | b'X' => {
                        self.pending.clear();
                        self.state = ControlState::String { escaped: false };
                    }
                    b'[' if self.pending.len() == 1 => {
                        self.pending.push(byte);
                        self.state = ControlState::Csi;
                    }
                    0x20..=0x2f => self.push_bounded(byte),
                    0x30..=0x7e => {
                        self.push_bounded(byte);
                        self.finish(&mut accepted);
                    }
                    0x18 | 0x1a => self.cancel(),
                    _ => {}
                },
                ControlState::Csi => match byte {
                    0x1b => self.begin_escape(),
                    0x18 | 0x1a => self.cancel(),
                    0x40..=0x7e => {
                        self.push_bounded(byte);
                        self.finish(&mut accepted);
                    }
                    _ => self.push_bounded(byte),
                },
                ControlState::String { escaped } => {
                    if byte == 0x07 || byte == 0x18 || byte == 0x1a || (*escaped && byte == b'\\') {
                        self.cancel();
                    } else {
                        *escaped = byte == 0x1b;
                    }
                }
            }
        }
        parser.process(&accepted);
        !accepted.is_empty()
    }

    fn begin_escape(&mut self) {
        self.pending.clear();
        self.pending.push(0x1b);
        self.overflow = false;
        self.state = ControlState::Escape;
    }

    fn push_bounded(&mut self, byte: u8) {
        if self.pending.len() < MAX_CONTROL_BYTES {
            self.pending.push(byte);
        } else {
            self.overflow = true;
        }
    }

    fn finish(&mut self, accepted: &mut Vec<u8>) {
        if !self.overflow {
            accepted.extend_from_slice(&self.pending);
        }
        self.cancel();
    }

    fn cancel(&mut self) {
        self.pending.clear();
        self.overflow = false;
        self.state = ControlState::Ground;
    }
}

struct ScreenState {
    parser: vt100::Parser<Replies>,
    filter: ControlFilter,
    version: u64,
    session: u64,
    running: bool,
}

impl ScreenState {
    fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                rows,
                cols,
                SCROLLBACK_ROWS,
                Replies::default(),
            ),
            filter: ControlFilter::default(),
            version: 0,
            session: 0,
            running: false,
        }
    }
}

#[derive(Default)]
struct PendingInput {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
}

struct InputQueue {
    pending: Mutex<PendingInput>,
    ready: Condvar,
    stopped: Arc<AtomicBool>,
}

impl InputQueue {
    fn push(&self, bytes: &[u8], reply: bool) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut pending = self.pending.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) {
            return Err("Terminal is stopped".into());
        }
        if bytes.len() > MAX_INPUT_BYTES
            || pending.bytes + bytes.len() > MAX_INPUT_BYTES
            || pending.chunks.len() >= MAX_INPUT_CHUNKS
        {
            return Err("Terminal input queue is full (64 KiB / 64 chunks limit)".into());
        }
        pending.bytes += bytes.len();
        if reply {
            pending.chunks.push_front(bytes.to_vec());
        } else {
            pending.chunks.push_back(bytes.to_vec());
        }
        self.ready.notify_one();
        Ok(())
    }

    fn pop(&self) -> Option<Vec<u8>> {
        let mut pending = self.pending.lock().unwrap();
        loop {
            if self.stopped.load(Ordering::Acquire) {
                pending.chunks.clear();
                pending.bytes = 0;
                return None;
            }
            if let Some(bytes) = pending.chunks.pop_front() {
                // Count bytes in the writer's current chunk against the cap.
                return Some(bytes);
            }
            pending = self.ready.wait(pending).unwrap();
        }
    }

    fn consumed(&self, bytes: usize) {
        let mut pending = self.pending.lock().unwrap();
        pending.bytes = pending.bytes.saturating_sub(bytes);
    }
}

struct Process {
    master: Box<dyn MasterPty + Send>,
    input: Arc<InputQueue>,
    stopped: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
    waiter: JoinHandle<()>,
}

pub struct Terminal {
    screen: Arc<Mutex<ScreenState>>,
    // Serializes start/stop/resize without blocking the output parser.
    process: Mutex<Option<Process>>,
    changes: watch::Sender<u64>,
}

impl Terminal {
    /// Merely allocating/subscribing does not spawn a shell.
    pub fn new() -> Arc<Self> {
        let (changes, _) = watch::channel(0);
        Arc::new(Self {
            screen: Arc::new(Mutex::new(ScreenState::new(24, 80))),
            process: Mutex::new(None),
            changes,
        })
    }

    /// Latest revision only; slow/offline browsers never queue output bytes.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn ensure_started(self: &Arc<Self>, workspace: &Path) -> Result<(), String> {
        self.start_command(workspace, shell_command())
    }

    fn start_command(
        self: &Arc<Self>,
        workspace: &Path,
        mut command: CommandBuilder,
    ) -> Result<(), String> {
        let mut slot = self.process.lock().unwrap();
        if slot.as_ref().is_some_and(|p| {
            !p.exited.load(Ordering::Acquire) && !p.stopped.load(Ordering::Acquire)
        }) {
            return Ok(());
        }
        if let Some(previous) = slot.take() {
            previous.close();
        }
        let workspace = workspace
            .canonicalize()
            .map_err(|e| format!("Terminal workspace: {e}"))?;
        if !workspace.is_dir() {
            return Err("Terminal workspace must be a directory".into());
        }
        let (rows, cols) = self.screen.lock().unwrap().parser.screen().size();
        let pair = native_pty_system()
            .openpty(pty_size(cols, rows))
            .map_err(|e| format!("Open terminal: {e}"))?;
        command.cwd(workspace);
        command.env("TERM", "vt100");
        command.env("COLORTERM", "truecolor");
        let (mut reader, reader_fd) =
            terminal_reader(pair.master.as_ref()).map_err(|e| format!("Terminal reader: {e}"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Terminal writer: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("Start shell: {e}"))?;
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let stopped = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(AtomicBool::new(false));
        let input = Arc::new(InputQueue {
            pending: Mutex::new(PendingInput::default()),
            ready: Condvar::new(),
            stopped: stopped.clone(),
        });
        let session = {
            let mut screen = self.screen.lock().unwrap();
            let version = screen.version;
            let session = screen.session.wrapping_add(1);
            *screen = ScreenState::new(rows, cols);
            screen.session = session;
            screen.version = version.wrapping_add(1);
            screen.running = true;
            self.changes.send_replace(screen.version);
            session
        };

        let reader_screen = self.screen.clone();
        let reader_changes = self.changes.clone();
        let reader_stop = stopped.clone();
        let reader_input = input.clone();
        let reader_thread = thread::spawn(move || {
            let mut bytes = [0; READ_BYTES];
            // Older Windows ConPTY requires output to keep draining while
            // ClosePseudoConsole runs. Unix uses cancellable nonblocking I/O.
            while !cfg!(unix) || !reader_stop.load(Ordering::Acquire) {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) => {
                        if reader_stop.load(Ordering::Acquire) {
                            continue;
                        }
                        let replies = process_output(
                            &reader_screen,
                            &reader_changes,
                            session,
                            &bytes[..count],
                        );
                        if !replies.is_empty() {
                            let _ = reader_input.push(&replies, true);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        wait_for_output(reader_fd);
                    }
                    Err(_) => break,
                }
            }
        });
        let writer_input = input.clone();
        let writer_stop = stopped.clone();
        let writer_thread = thread::spawn(move || {
            while let Some(bytes) = writer_input.pop() {
                let mut offset = 0;
                while offset < bytes.len() && !writer_stop.load(Ordering::Acquire) {
                    let end = (offset + READ_BYTES).min(bytes.len());
                    match writer.write(&bytes[offset..end]) {
                        Ok(0) => {
                            writer_stop.store(true, Ordering::Release);
                            break;
                        }
                        Ok(count) => {
                            offset += count;
                            writer_input.consumed(count);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10))
                        }
                        Err(_) => {
                            writer_stop.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
            }
        });
        let waiter_screen = self.screen.clone();
        let waiter_changes = self.changes.clone();
        let child_exited = exited.clone();
        let waiter = thread::spawn(move || {
            let _ = child.wait();
            child_exited.store(true, Ordering::Release);
            mark_exited(&waiter_screen, &waiter_changes, session);
        });
        *slot = Some(Process {
            master: pair.master,
            input,
            stopped,
            exited,
            killer,
            pid,
            reader: reader_thread,
            writer: writer_thread,
            waiter,
        });
        Ok(())
    }

    pub fn input(&self, bytes: &[u8]) -> Result<(), String> {
        let slot = self.process.lock().unwrap();
        let process = slot
            .as_ref()
            .filter(|p| !p.exited.load(Ordering::Acquire))
            .ok_or("Terminal is not running")?;
        // U+0003 is written to the PTY: the OS line discipline sends SIGINT
        // to the foreground job, rather than terminating the shell itself.
        process.input.push(bytes, false)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = dimensions(cols, rows);
        let slot = self.process.lock().unwrap();
        // Block output processing until the canonical grid matches the PTY.
        // In particular, a shell's SIGWINCH redraw must use the new size.
        let mut screen = self.screen.lock().unwrap();
        if let Some(process) = slot.as_ref() {
            process
                .master
                .resize(pty_size(cols, rows))
                .map_err(|e| format!("Resize terminal: {e}"))?;
        }
        if screen.parser.screen().size() != (rows, cols) {
            let pending_wrap = pending_wrap_cell(screen.parser.screen(), cols);
            preserve_normal_columns(&mut screen.parser, cols);
            preserve_normal_rows(&mut screen.parser, rows);
            screen.parser.screen_mut().set_size(rows, cols);
            if let Some((start, cell, attributes)) = pending_wrap {
                let row = screen.parser.screen().cursor_position().0;
                screen
                    .parser
                    .process(format!("\x1b[{};{}H\x1b[0m", row + 1, start + 1).as_bytes());
                screen.parser.process(&cell);
                screen.parser.process(&attributes);
            }
            screen.version = screen.version.wrapping_add(1);
            self.changes.send_replace(screen.version);
        }
        Ok(())
    }

    pub fn stop(&self) {
        self.close(false);
    }

    /// End the previous project's shell and discard its canonical terminal
    /// state. Dimensions are retained so the next lazy shell fits its client.
    pub fn reset(&self) {
        self.close(true);
    }

    fn close(&self, reset: bool) {
        let mut slot = self.process.lock().unwrap();
        let process = slot.take();
        // Fence output from old worker threads before closing OS handles.
        {
            let mut screen = self.screen.lock().unwrap();
            let session = screen.session.wrapping_add(1);
            if reset {
                let (rows, cols) = screen.parser.screen().size();
                let version = screen.version.wrapping_add(1);
                *screen = ScreenState::new(rows, cols);
                screen.session = session;
                screen.version = version;
                self.changes.send_replace(screen.version);
            } else if screen.running {
                screen.session = session;
                screen.running = false;
                screen.version = screen.version.wrapping_add(1);
                self.changes.send_replace(screen.version);
            } else {
                screen.session = session;
            }
        }
        if let Some(process) = process {
            process.close();
        }
    }

    pub fn snapshot(&self) -> TerminalSnapshot {
        let state = self.screen.lock().unwrap();
        let screen = state.parser.screen();
        let (rows, cols) = screen.size();
        let (row, col) = screen.cursor_position();
        TerminalSnapshot {
            cols,
            rows,
            lines: (0..rows).map(|row| line(screen, row, cols)).collect(),
            cursor: TerminalCursor {
                row: row.min(rows - 1),
                col: col.min(cols - 1),
                visible: !screen.hide_cursor(),
            },
            running: state.running,
            bracketed_paste: screen.bracketed_paste(),
            application_cursor: screen.application_cursor(),
            application_keypad: screen.application_keypad(),
            alternate_screen: screen.alternate_screen(),
            version: state.version,
        }
    }

    /// History is fetched explicitly; the regular snapshot contains only the
    /// active grid. The returned history is always capped at 200 rows.
    #[allow(dead_code)] // Host transport can expose an explicit history request.
    pub fn history(&self, limit: usize) -> Vec<TerminalLine> {
        let mut screen = self.screen.lock().unwrap().parser.screen().clone();
        if screen.alternate_screen() {
            return Vec::new();
        }
        screen.set_scrollback(limit.min(SCROLLBACK_ROWS));
        let retained = screen.scrollback();
        let (rows, _) = screen.size();
        let mut result = Vec::with_capacity(retained);
        let mut remaining = retained;
        while remaining > 0 {
            screen.set_scrollback(remaining);
            let count = remaining.min(usize::from(rows));
            // Scrollback rows retain the width at which they were produced.
            // Reading only the current width would hide old wide output.
            result.extend((0..count).map(|row| line(&screen, row as u16, MAX_COLS)));
            remaining -= count;
        }
        result
    }

    #[cfg(test)]
    fn process_output(&self, session: u64, bytes: &[u8]) -> Vec<u8> {
        process_output(&self.screen, &self.changes, session, bytes)
    }
}

/// Preserve a full-width normal-screen snapshot in the same bounded history
/// before narrowing would clip any text or visible styling. The active grid
/// then uses native VT cell resizing (no horizontal reflow). Consequently,
/// history can include pre-resize copies of rows that remain partly visible.
/// A normal-screen custom scrolling region/origin is reset when archiving.
fn preserve_normal_columns(parser: &mut vt100::Parser<Replies>, cols: u16) {
    let screen = parser.screen();
    let (rows, old_cols) = screen.size();
    if screen.alternate_screen() || cols >= old_cols {
        return;
    }
    if !(0..rows)
        .any(|row| (cols..old_cols).any(|col| screen.cell(row, col).is_some_and(visible_cell)))
    {
        return;
    }
    archive_normal_grid(parser);
}

fn visible_cell(cell: &vt100::Cell) -> bool {
    cell.has_contents()
        || cell.is_wide_continuation()
        || cell.bgcolor() != vt100::Color::Default
        || cell.inverse()
}

fn archive_normal_grid(parser: &mut vt100::Parser<Replies>) {
    let screen = parser.screen();
    let (rows, cols) = screen.size();
    let last_used = (0..rows)
        .rev()
        .find(|&row| (0..cols).any(|col| screen.cell(row, col).is_some_and(visible_cell)))
        .unwrap_or(0);
    let count = (last_used.max(screen.cursor_position().0) + 1).min(rows);
    let restore = screen.contents_formatted();
    parser.process(format!("\x1b[?6l\x1b[r\x1b[{count}S").as_bytes());
    parser.process(&restore);
}

/// vt100's native resize truncates bottom rows. Before a normal-screen shrink,
/// scroll the cursor's recent output into the retained rows; displaced top rows
/// enter the emulator's bounded scrollback with their original cells/styles.
/// Full-screen applications normally use the alternate screen and redraw on
/// SIGWINCH. For a normal-screen custom scrolling region, a vertical shrink
/// that displaces the cursor resets the region and origin mode to full-screen.
/// Other drawing and input modes are retained. This is cell preservation, not
/// horizontal text reflow.
fn preserve_normal_rows(parser: &mut vt100::Parser<Replies>, rows: u16) {
    let screen = parser.screen();
    let (old_rows, cols) = screen.size();
    let (row, col) = screen.cursor_position();
    if screen.alternate_screen() || rows >= old_rows {
        return;
    }
    let shift = (row + 1).saturating_sub(rows);
    // Applications can move the cursor above already drawn output. Archive
    // meaningful rows below the retained viewport before they are clipped.
    if (shift + rows..old_rows)
        .any(|row| (0..cols).any(|col| screen.cell(row, col).is_some_and(visible_cell)))
    {
        archive_normal_grid(parser);
    }
    if shift == 0 {
        return;
    }
    // Use the emulator's supported VT sequences rather than rebuilding its
    // screen, which would discard history, cell attributes and input modes.
    parser.process(format!("\x1b[?6l\x1b[r\x1b[{shift}S\x1b[{};{}H", rows, col + 1).as_bytes());
}

/// Native set_size clamps even a pending-wrap cursor to the last cell. If the
/// width is unchanged, replay its final cell after resizing to keep the next
/// character wrapping rather than overwriting that cell. The public formatter
/// retains wide/combining glyphs and styles, and SGR restores active attributes.
fn pending_wrap_cell(screen: &vt100::Screen, cols: u16) -> Option<(u16, Vec<u8>, Vec<u8>)> {
    let (_, old_cols) = screen.size();
    let (row, col) = screen.cursor_position();
    if cols != old_cols || col < cols {
        return None;
    }
    let width = if screen
        .cell(row, cols - 1)
        .is_some_and(vt100::Cell::is_wide_continuation)
    {
        2
    } else {
        1
    };
    let start = cols.saturating_sub(width);
    Some((
        start,
        screen
            .rows_formatted(start, cols - start)
            .nth(usize::from(row))?,
        screen.attributes_formatted(),
    ))
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Process {
    fn close(mut self) {
        self.stopped.store(true, Ordering::Release);
        self.input.ready.notify_all();
        #[cfg(unix)]
        let foreground = self.master.process_group_leader();
        if !self.exited.load(Ordering::Acquire) {
            #[cfg(unix)]
            if let Some(group) = foreground {
                signal_group(group, libc::SIGHUP);
                signal_group(group, libc::SIGCONT);
            }
            let _ = self.killer.kill();
            #[cfg(unix)]
            {
                let deadline = Instant::now() + Duration::from_millis(250);
                while !self.exited.load(Ordering::Acquire) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(10));
                }
                if !self.exited.load(Ordering::Acquire) {
                    if let Some(group) = foreground {
                        signal_group(group, libc::SIGKILL);
                    }
                    if let Some(pid) = self.pid {
                        signal_group(pid as i32, libc::SIGKILL);
                        // Safety: pid is from the live child owned by waiter;
                        // SIGKILL ensures an ignored SIGHUP cannot hang stop.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                }
            }
        }
        // On Unix, nonblocking workers observe `stopped` and release their
        // cloned descriptors. On Windows, closing ConPTY unblocks its pipes.
        drop(self.master);
        let current = thread::current().id();
        for worker in [self.reader, self.writer, self.waiter] {
            // Avoid joining the current thread if shutdown is ever invoked
            // by a worker; all other worker handles are explicitly reaped.
            if worker.thread().id() != current {
                let _ = worker.join();
            }
        }
    }
}

#[cfg(unix)]
fn signal_group(group: i32, signal: i32) {
    if group > 0 {
        // Safety: a positive group comes from this terminal's controlling
        // process group or its owned shell PID, never the host's group.
        unsafe {
            libc::kill(-group, signal);
        }
    }
}

#[cfg(unix)]
fn terminal_reader(master: &dyn MasterPty) -> Result<(Box<dyn Read + Send>, Option<i32>), String> {
    use std::os::fd::FromRawFd;
    let fd = master.as_raw_fd().ok_or("PTY has no native descriptor")?;
    // Safety: fcntl only changes the flags on this owned terminal. Dup gives
    // the reader its own descriptor; the open-description flags also make
    // the cloned writer nonblocking, so stop cannot wait on a full PTY.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let reader = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if reader < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok((
        Box::new(unsafe { std::fs::File::from_raw_fd(reader) }),
        Some(reader),
    ))
}

#[cfg(not(unix))]
fn terminal_reader(master: &dyn MasterPty) -> Result<(Box<dyn Read + Send>, Option<i32>), String> {
    master
        .try_clone_reader()
        .map(|reader| (reader, None))
        .map_err(|e| e.to_string())
}

fn wait_for_output(fd: Option<i32>) {
    #[cfg(unix)]
    if let Some(fd) = fd {
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // Safety: fd remains owned by the reader on this same thread.
        unsafe {
            libc::poll(&mut poll, 1, 100);
        }
        return;
    }
    let _ = fd;
    thread::sleep(Duration::from_millis(10));
}

fn process_output(
    screen: &Mutex<ScreenState>,
    changes: &watch::Sender<u64>,
    session: u64,
    bytes: &[u8],
) -> Vec<u8> {
    let mut state = screen.lock().unwrap();
    if state.session != session {
        return Vec::new();
    }
    let ScreenState { filter, parser, .. } = &mut *state;
    if !filter.process(bytes, parser) {
        return Vec::new();
    }
    let replies = std::mem::take(&mut parser.callbacks_mut().0);
    state.version = state.version.wrapping_add(1);
    changes.send_replace(state.version);
    replies
}

fn mark_exited(screen: &Mutex<ScreenState>, changes: &watch::Sender<u64>, session: u64) {
    let mut state = screen.lock().unwrap();
    if state.session == session && state.running {
        state.running = false;
        state.version = state.version.wrapping_add(1);
        changes.send_replace(state.version);
    }
}

fn dimensions(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(1, MAX_COLS), rows.clamp(1, MAX_ROWS))
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn shell_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        let shell = std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into());
        CommandBuilder::new(shell)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var_os("SHELL")
            .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
            .unwrap_or_else(|| "/bin/sh".into());
        let mut command = CommandBuilder::new(shell);
        command.arg("-i");
        command
    }
}

fn line(screen: &vt100::Screen, row: u16, cols: u16) -> TerminalLine {
    let mut runs: Vec<TerminalRun> = Vec::new();
    let mut mergeable = false;
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else {
            continue;
        };
        if cell.is_wide_continuation() {
            continue;
        }
        let text = if cell.has_contents() {
            cell.contents()
        } else {
            " "
        };
        let width = (if cell.is_wide() { 2 } else { 1 }).min(cols - col);
        let simple = text.len() == 1 && text.is_ascii();
        let run = TerminalRun {
            text: text.to_owned(),
            col,
            cols: width,
            fg: color(cell.fgcolor()),
            bg: color(cell.bgcolor()),
            bold: cell.bold(),
            dim: cell.dim(),
            italic: cell.italic(),
            underline: cell.underline(),
            inverse: cell.inverse(),
        };
        if simple
            && mergeable
            && let Some(previous) = runs.last_mut().filter(|p| same_style(p, &run))
        {
            previous.text.push_str(text);
            previous.cols += width;
            continue;
        }
        runs.push(run);
        mergeable = simple;
    }
    TerminalLine { runs }
}

fn same_style(left: &TerminalRun, right: &TerminalRun) -> bool {
    left.fg == right.fg
        && left.bg == right.bg
        && left.bold == right.bold
        && left.dim == right.dim
        && left.italic == right.italic
        && left.underline == right.underline
        && left.inverse == right.inverse
}

fn color(color: vt100::Color) -> Option<String> {
    const ANSI: [(u8, u8, u8); 16] = [
        (0, 0, 0),
        (205, 49, 49),
        (13, 188, 121),
        (229, 229, 16),
        (36, 114, 200),
        (188, 63, 188),
        (17, 168, 205),
        (229, 229, 229),
        (102, 102, 102),
        (241, 76, 76),
        (35, 209, 139),
        (245, 245, 67),
        (59, 142, 234),
        (214, 112, 214),
        (41, 184, 219),
        (255, 255, 255),
    ];
    let (r, g, b) = match color {
        vt100::Color::Default => return None,
        vt100::Color::Rgb(r, g, b) => (r, g, b),
        vt100::Color::Idx(index @ 0..=15) => ANSI[usize::from(index)],
        vt100::Color::Idx(index @ 16..=231) => {
            let index = index - 16;
            let component = |n: u8| if n == 0 { 0 } else { 55 + 40 * n };
            (
                component(index / 36),
                component((index / 6) % 6),
                component(index % 6),
            )
        }
        vt100::Color::Idx(index) => {
            let component = 8 + 10 * (index - 232);
            (component, component, component)
        }
    };
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contents(snapshot: &TerminalSnapshot) -> String {
        snapshot
            .lines
            .iter()
            .map(|l| {
                l.runs
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn feed(terminal: &Terminal, bytes: &[u8]) -> Vec<u8> {
        let session = terminal.screen.lock().unwrap().session;
        terminal.process_output(session, bytes)
    }

    #[test]
    fn snapshots_preserve_styles_unicode_cursor_and_alternate_screen() {
        let terminal = Terminal::new();
        assert!(!terminal.snapshot().running);
        for byte in "normal\r\n界e\u{301}".as_bytes() {
            feed(&terminal, &[*byte]);
        }
        feed(
            &terminal,
            b"\x1b[1;3;4;38;2;12;34;56mX\x1b[0m\x1b[?2004h\x1b[?1h\x1b=",
        );
        let snapshot = terminal.snapshot();
        assert!(contents(&snapshot).contains("界e\u{301}X"));
        let wide = snapshot.lines[1]
            .runs
            .iter()
            .find(|r| r.text == "界")
            .unwrap();
        assert_eq!((wide.col, wide.cols), (0, 2));
        let styled = snapshot.lines[1]
            .runs
            .iter()
            .find(|r| r.text == "X")
            .unwrap();
        assert_eq!(styled.fg.as_deref(), Some("#0c2238"));
        assert!(styled.bold && styled.italic && styled.underline);
        assert!(
            snapshot.bracketed_paste && snapshot.application_cursor && snapshot.application_keypad
        );
        assert_eq!((snapshot.cursor.row, snapshot.cursor.col), (1, 4));
        feed(&terminal, b"\x1b[?1049h\x1b[Halt\x1b[?25l");
        let alternate = terminal.snapshot();
        assert!(alternate.alternate_screen && !alternate.cursor.visible);
        assert!(contents(&alternate).starts_with("alt"));
        feed(&terminal, b"\x1b[?1049l\x1b[?25h");
        let normal = terminal.snapshot();
        assert!(!normal.alternate_screen && normal.cursor.visible);
        assert!(contents(&normal).starts_with("normal"));
    }

    #[test]
    fn phone_desktop_resize_preserves_recent_rows_cursor_styles_and_history() {
        let terminal = Terminal::new();
        terminal.resize(42, 28).unwrap();
        for index in 0..24 {
            feed(
                &terminal,
                format!("\x1b[1;3;4;38;2;12;34;56mline-{index:02} 界e\u{301}\x1b[0m\r\n")
                    .as_bytes(),
            );
        }
        feed(
            &terminal,
            b"prompt> \x1b[?2004h\x1b[?1h\x1b=\x1b[?25l\x1b[38;2;50;60;70m",
        );
        let before = contents(&terminal.snapshot());
        assert_eq!(terminal.history(200).len(), 0);
        assert_eq!(terminal.snapshot().cursor.row, 24);

        terminal.resize(160, 8).unwrap();
        let small = terminal.snapshot();
        assert_eq!((small.cursor.row, small.cursor.col), (7, 8));
        assert!(!small.cursor.visible);
        assert!(small.bracketed_paste && small.application_cursor && small.application_keypad);
        assert!(contents(&small).starts_with("line-17 界e\u{301}"));
        assert!(contents(&small).contains("line-23 界e\u{301}\nprompt>"));
        let history = terminal.history(200);
        assert_eq!(history.len(), 17);
        for line in history.iter().chain(&small.lines).take(24) {
            let wide = line.runs.iter().find(|run| run.text == "界").unwrap();
            assert_eq!((wide.col, wide.cols), (8, 2));
            assert_eq!(wide.fg.as_deref(), Some("#0c2238"));
            assert!(wide.bold && wide.italic && wide.underline);
            assert!(line.runs.iter().any(|run| run.text == "e\u{301}"));
        }
        let mut all = small.clone();
        all.lines = history.into_iter().chain(small.lines).collect();
        assert_eq!(contents(&all).trim_end(), before.trim_end());

        terminal.resize(42, 28).unwrap();
        let large = terminal.snapshot();
        assert_eq!((large.cursor.row, large.cursor.col), (7, 8));
        assert!(large.bracketed_paste && large.application_cursor && large.application_keypad);
        assert!(!large.cursor.visible);
        let mut all = large.clone();
        all.lines = terminal
            .history(200)
            .into_iter()
            .chain(large.lines)
            .collect();
        assert_eq!(contents(&all).trim_end(), before.trim_end());
        feed(&terminal, b"X");
        let large = terminal.snapshot();
        let styled = large.lines[7]
            .runs
            .iter()
            .find(|run| run.text == "X")
            .unwrap();
        assert_eq!(styled.fg.as_deref(), Some("#323c46"));
        assert_eq!((large.cursor.row, large.cursor.col), (7, 9));

        // Alternate-screen entry/exit still restores the retained normal grid.
        feed(&terminal, b"\x1b[?1049halt");
        assert!(terminal.snapshot().alternate_screen);
        terminal.resize(42, 8).unwrap();
        assert!(terminal.snapshot().alternate_screen);
        assert!(terminal.history(200).is_empty());
        feed(&terminal, b"\x1b[?1049l");
        assert!(contents(&terminal.snapshot()).contains("prompt> X"));
        assert_eq!(terminal.history(200).len(), 17);
    }

    #[test]
    fn displaced_normal_cursor_resets_custom_region_on_vertical_shrink() {
        let terminal = Terminal::new();
        terminal.resize(42, 28).unwrap();
        for index in 0..24 {
            feed(&terminal, format!("line-{index:02}\r\n").as_bytes());
        }
        feed(&terminal, b"\x1b[3;27r\x1b[?6h\x1b[22;1Hregion-prompt");
        terminal.resize(42, 8).unwrap();
        assert_eq!(terminal.snapshot().cursor.row, 7);
        assert!(contents(&terminal.snapshot()).contains("region-prompt"));
        assert_eq!(terminal.history(200).len(), 16);
        // Home is the physical top after the documented region/origin reset.
        feed(&terminal, b"\x1b[Htop");
        assert_eq!(terminal.snapshot().cursor.row, 0);
        assert!(contents(&terminal.snapshot()).starts_with("top"));
    }

    #[test]
    fn width_shrink_retains_full_unicode_and_styles_in_bounded_history() {
        let terminal = Terminal::new();
        terminal.resize(160, 8).unwrap();
        let wide_text = format!("earlier-{}界e\u{301}-HISTORY-END", "x".repeat(90));
        feed(
            &terminal,
            format!("\x1b[1;38;2;12;34;56m{wide_text}\x1b[0m\r\n").as_bytes(),
        );
        for index in 0..16 {
            feed(&terminal, format!("row-{index:02}\r\n").as_bytes());
        }
        feed(
            &terminal,
            "\x1b[6;100H\x1b[3;4;38;2;60;70;80m界e\u{301}-ACTIVE-END".as_bytes(),
        );
        feed(
            &terminal,
            b"\x1b[3;9H\x1b[38;2;50;60;70m\x1b[?2004h\x1b[?1h\x1b=\x1b[?25l",
        );
        terminal.resize(42, 28).unwrap();
        let small = terminal.snapshot();
        assert_eq!((small.cursor.row, small.cursor.col), (2, 8));
        assert!(small.bracketed_paste && small.application_cursor && small.application_keypad);
        assert!(!small.cursor.visible);
        let history = terminal.history(200);
        let mut retained = small.clone();
        retained.lines = history.clone();
        let text = contents(&retained);
        assert!(text.contains(&wide_text));
        assert!(text.contains("界e\u{301}-ACTIVE-END"));
        let earlier = history
            .iter()
            .flat_map(|line| &line.runs)
            .find(|run| run.text == "界" && run.bold)
            .unwrap();
        assert_eq!(earlier.fg.as_deref(), Some("#0c2238"));
        let active = history
            .iter()
            .flat_map(|line| &line.runs)
            .find(|run| run.text == "界" && run.italic)
            .unwrap();
        assert_eq!((active.col, active.cols), (99, 2));
        assert_eq!(active.fg.as_deref(), Some("#3c4650"));
        assert!(active.underline);
        assert!(
            history
                .iter()
                .flat_map(|line| &line.runs)
                .any(|run| run.col + run.cols > small.cols)
        );
        feed(&terminal, b"X");
        let current = terminal.snapshot();
        assert_eq!(
            current.lines[2]
                .runs
                .iter()
                .find(|run| run.text == "X")
                .unwrap()
                .fg
                .as_deref(),
            Some("#323c46")
        );
        terminal.resize(160, 8).unwrap();
        let mut retained = terminal.snapshot();
        retained.lines = terminal.history(200);
        assert!(contents(&retained).contains(&wide_text));
        assert!(contents(&retained).contains("界e\u{301}-ACTIVE-END"));
        for _ in 0..220 {
            feed(&terminal, b"\r\nwide-row\x1b[100GX");
            terminal.resize(42, 8).unwrap();
            terminal.resize(160, 8).unwrap();
        }
        assert_eq!(terminal.history(usize::MAX).len(), SCROLLBACK_ROWS);
    }

    #[test]
    fn height_shrink_archives_output_below_cursor_and_preserves_pending_wrap() {
        let terminal = Terminal::new();
        terminal.resize(42, 28).unwrap();
        feed(
            &terminal,
            "\x1b[25;1H\x1b[38;2;12;34;56mBOTTOM-界e\u{301}\x1b[0m\x1b[Htop".as_bytes(),
        );
        terminal.resize(160, 8).unwrap();
        assert_eq!(
            (
                terminal.snapshot().cursor.row,
                terminal.snapshot().cursor.col
            ),
            (0, 3)
        );
        let mut retained = terminal.snapshot();
        retained.lines = terminal.history(200);
        assert!(contents(&retained).contains("BOTTOM-界e\u{301}"));

        let terminal = Terminal::new();
        terminal.resize(42, 28).unwrap();
        feed(&terminal, b"\x1b[25;1H\x1b[38;2;12;34;56m");
        feed(&terminal, "x".repeat(40).as_bytes());
        feed(&terminal, "界".as_bytes());
        let position = terminal
            .screen
            .lock()
            .unwrap()
            .parser
            .screen()
            .cursor_position();
        assert_eq!(position, (24, 42));
        terminal.resize(42, 8).unwrap();
        let position = terminal
            .screen
            .lock()
            .unwrap()
            .parser
            .screen()
            .cursor_position();
        assert_eq!(position, (7, 42));
        feed(&terminal, b"Z");
        let small = terminal.snapshot();
        assert!(contents(&small).contains("xxxxxxxx界\nZ"));
        assert_eq!((small.cursor.row, small.cursor.col), (7, 1));
        assert_eq!(
            small.lines[7]
                .runs
                .iter()
                .find(|run| run.text == "Z")
                .unwrap()
                .fg
                .as_deref(),
            Some("#0c2238")
        );
    }

    #[test]
    fn project_reset_clears_grid_history_modes_and_fences_previous_output() {
        let terminal = Terminal::new();
        terminal.resize(42, 8).unwrap();
        for _ in 0..20 {
            feed(&terminal, b"\x1b[1;3;4;31;44mold-project\r\n");
        }
        assert!(!terminal.history(200).is_empty());
        feed(
            &terminal,
            b"\x1b[?2004h\x1b[?1h\x1b=\x1b[?1049h\x1b[?25lold-alternate",
        );
        let old_session = terminal.screen.lock().unwrap().session;
        let before = terminal.snapshot();
        assert!(before.alternate_screen);
        terminal.reset();
        let reset = terminal.snapshot();
        assert_eq!((reset.cols, reset.rows), (42, 8));
        assert_eq!((reset.cursor.row, reset.cursor.col), (0, 0));
        assert!(reset.cursor.visible);
        assert!(!reset.running && !reset.alternate_screen);
        assert!(!reset.bracketed_paste && !reset.application_cursor && !reset.application_keypad);
        assert!(reset.version > before.version);
        assert!(contents(&reset).trim().is_empty());
        assert!(terminal.history(200).is_empty());
        for run in reset.lines.iter().flat_map(|line| &line.runs) {
            assert!(run.fg.is_none() && run.bg.is_none());
            assert!(!run.bold && !run.italic && !run.underline && !run.inverse);
        }
        assert!(
            terminal
                .process_output(old_session, b"late-old-project")
                .is_empty()
        );
        assert_eq!(terminal.snapshot().version, reset.version);
        feed(&terminal, b"new-project");
        assert!(contents(&terminal.snapshot()).starts_with("new-project"));
    }

    #[test]
    fn replies_are_bounded_and_report_the_canonical_cursor() {
        let terminal = Terminal::new();
        assert_eq!(
            feed(&terminal, b"\x1b[3;7H\x1b[6n\x1b[5n\x1b[c"),
            b"\x1b[3;7R\x1b[0n\x1b[?1;2c"
        );
        let queries = b"\x1b[6n".repeat(2000);
        assert!(feed(&terminal, &queries).len() <= MAX_REPLY_BYTES);
    }

    #[test]
    fn hostile_strings_dimensions_history_and_slow_watchers_are_bounded() {
        let terminal = Terminal::new();
        let watcher = terminal.subscribe();
        feed(&terminal, b"\x1b]52;c;");
        let chunk = [b'A'; READ_BYTES];
        for _ in 0..256 {
            feed(&terminal, &chunk);
        }
        feed(&terminal, b"\x1b\\visible");
        assert!(contents(&terminal.snapshot()).starts_with("visible"));
        assert!(terminal.screen.lock().unwrap().filter.pending.capacity() <= MAX_CONTROL_BYTES);
        feed(&terminal, b"\x1b[");
        let parameters = [b'1'; READ_BYTES];
        for _ in 0..16 {
            feed(&terminal, &parameters);
        }
        feed(&terminal, b"mstill-visible");
        assert!(contents(&terminal.snapshot()).starts_with("visiblestill-visible"));
        terminal.resize(u16::MAX, u16::MAX).unwrap();
        assert_eq!(
            (terminal.snapshot().cols, terminal.snapshot().rows),
            (MAX_COLS, MAX_ROWS)
        );
        feed(&terminal, b"row\r\n".repeat(1000).as_slice());
        assert_eq!(terminal.history(usize::MAX).len(), SCROLLBACK_ROWS);
        terminal.resize(0, 0).unwrap();
        assert_eq!((terminal.snapshot().cols, terminal.snapshot().rows), (1, 1));
        assert_eq!(*watcher.borrow(), terminal.snapshot().version);
        assert!(terminal.input(&[0; MAX_INPUT_BYTES + 1]).is_err());
    }

    #[test]
    fn input_cap_counts_the_chunk_currently_being_written() {
        let queue = InputQueue {
            pending: Mutex::new(PendingInput::default()),
            ready: Condvar::new(),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        queue.push(&vec![b'x'; MAX_INPUT_BYTES], false).unwrap();
        let bytes = queue.pop().unwrap();
        assert!(queue.push(b"y", false).is_err());
        queue.consumed(bytes.len());
        queue.push(b"y", false).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_real_terminal_program_receives_cursor_replies() {
        let workspace = tempfile::tempdir().unwrap();
        let terminal = Terminal::new();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            r#"stty -echo -icanon min 1 time 0; printf '\033[3;7H\033[6n'; reply=$(dd bs=1 count=6 2>/dev/null); expected=$(printf '\033[3;7R'); [ "$reply" = "$expected" ] && printf QUERYOK"#,
        ]);
        terminal.start_command(workspace.path(), command).unwrap();
        wait_for(&terminal, |s| contents(s).contains("QUERYOK"));
        wait_for(&terminal, |s| !s.running);
        terminal.stop();
    }

    #[cfg(unix)]
    #[test]
    fn dropping_the_host_closes_a_shell_that_ignores_hangup() {
        let workspace = tempfile::tempdir().unwrap();
        let terminal = Terminal::new();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "trap '' HUP; printf READY; while :; do sleep 1; done"]);
        terminal.start_command(workspace.path(), command).unwrap();
        wait_for(&terminal, |s| contents(s).contains("READY"));
        let pid = terminal
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .pid
            .unwrap();
        let start = Instant::now();
        drop(terminal);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }

    #[cfg(unix)]
    #[test]
    fn real_pty_survives_detachment_resizes_interrupts_and_closes() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace =
            std::env::temp_dir().join(format!("code-editor-pty-{}-{unique}", std::process::id()));
        std::fs::create_dir(&workspace).unwrap();
        let terminal = Terminal::new();
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-i");
        command.env("PS1", "");
        command.env("ENV", "");
        terminal.start_command(&workspace, command).unwrap();
        terminal.input(b"stty -echo\r").unwrap();
        thread::sleep(Duration::from_millis(100));
        terminal
            .input(b"test -t 0 && printf '%s%s\\n' 'PTY' 'READY'; pwd\r")
            .unwrap();
        wait_for(&terminal, |s| {
            contents(s).contains("PTYREADY")
                && contents(s)
                    .replace('\n', "")
                    .contains(workspace.file_name().unwrap().to_str().unwrap())
        });
        let pid = terminal
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .pid
            .unwrap();
        terminal.ensure_started(&workspace).unwrap();
        assert_eq!(
            terminal.process.lock().unwrap().as_ref().unwrap().pid,
            Some(pid)
        );
        // No subscriber/browser is attached during this command's output.
        terminal
            .input(b"printf '%s%s\\n' 'HIDDEN' 'OUTPUT'\r")
            .unwrap();
        wait_for(&terminal, |s| contents(s).contains("HIDDENOUTPUT"));
        let observer = terminal.subscribe();
        assert_eq!(*observer.borrow(), terminal.snapshot().version);
        terminal.resize(111, 37).unwrap();
        terminal.input(b"stty size\r").unwrap();
        wait_for(&terminal, |s| contents(s).contains("37 111"));
        terminal
            .input(
                b"printf '%s%s\\n' 'SLEEP' 'START'; sleep 30 && printf '%s%s\\n' 'SLEEP' 'END'\r",
            )
            .unwrap();
        wait_for(&terminal, |s| contents(s).contains("SLEEPSTART"));
        thread::sleep(Duration::from_millis(100));
        terminal.input(&[3]).unwrap();
        // The OS flushes queued input on SIGINT. Wait until that interrupt
        // has been delivered before typing the following shell command.
        thread::sleep(Duration::from_millis(100));
        terminal
            .input(b"printf '%s%s\\n' 'CTRL' 'ALIVE'\r")
            .unwrap();
        wait_for(&terminal, |s| contents(s).contains("CTRLALIVE"));
        assert!(!contents(&terminal.snapshot()).contains("SLEEPEND"));
        terminal
            .input(b"i=0; while [ $i -lt 500 ]; do printf 'row-%s\\n' \"$i\"; i=$((i+1)); done\r")
            .unwrap();
        wait_for(&terminal, |s| contents(s).contains("row-499"));
        assert_eq!(terminal.history(usize::MAX).len(), SCROLLBACK_ROWS);
        terminal.stop();
        assert!(!terminal.snapshot().running);
        assert!(terminal.input(b"echo never\r").is_err());
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            -1,
            "shell must be reaped"
        );
        std::fs::remove_dir(workspace).unwrap();
    }

    #[cfg(unix)]
    #[track_caller]
    fn wait_for(terminal: &Terminal, predicate: impl Fn(&TerminalSnapshot) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if predicate(&terminal.snapshot()) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected PTY state did not arrive"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}
