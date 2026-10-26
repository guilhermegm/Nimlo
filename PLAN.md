# Lightweight shared-session code editor

Status: a working first implementation now exists in `src/` and `web/`. The Rust host serves the custom editor, real files, durable shared drafts, full access from every paired device over LAN or an on-demand HTTPS internet tunnel, on-demand host terminals, and both official AI adapters. A combined Files tree attaches multiple host folders to one authenticated session. A persistent project switcher keeps the current Code, AI or Terminal surface while choosing another project; checked root names select projects independently of folder expansion. Devices choose files independently while drafts, shells and AI context remain tied to each project. Compact setup controls remember attached folders and the last selected project, choose the default provider/model/effort, and refresh native CLI sign-in status. See [README.md](README.md) for usage, [BUILD_GAUNTLET.md](BUILD_GAUNTLET.md) for independent review, and [PERFORMANCE.md](PERFORMANCE.md) for measured costs. The earlier interface mock remains in `mockup/`. This document keeps the broader design and future work as well as the implemented scope.

## Product intent

Build a new, extremely lightweight code editor with three defining features:

- Low RAM use, with explicit limits and reproducible measurements.
- AI integrated through the user's own Codex/ChatGPT and Claude subscriptions.
- One live session containing multiple host-PC project folders, accessible from a phone or another browser through a combined Files tree.

Use a custom editor engine: no CodeMirror, Monaco, or packaged IDE. A browser engine still consumes memory, so “near zero RAM” is an aspiration to minimize overhead, not a performance claim. The PC hosts the work and must remain powered on, awake, and reachable for other devices to use it. Cloud hosting is a possible later deployment, with its own eligibility and security requirements.

## Architecture

A small Rust host owns attached projects, versioned documents, bounded shared undo history, terminal processes, AI sessions, and recovery state. It serves the browser application and authenticated connections. Project identities scope asynchronous commands and events; devices can view different projects without moving one another. Keep unopened folders as metadata, load directory entries only on expansion, retain only the selected project's source in each browser, and start shells and provider jobs only on explicit use. Apply document and history bounds across all projects. Use simple private local persistence and avoid an always-running database or unnecessary services.

The first implementation uses a full native textarea for supported small files, with custom desktop syntax highlighting limited to visible lines plus a small margin. Mobile uses readable native plain text to keep wrapping and input aligned. Native selection and IME are used; advanced editor navigation, language-aware indentation, and large-file range loading remain future work. Implement selection, navigation, composition, and scrolling deliberately; native input alone does not solve mobile editing. Syntax highlighting and other language features load only when needed.

Each connected device needs some local document state for responsive typing. The first implementation may keep complete copies of supported small documents and enforce a documented size limit. Later, a specialized large-file path can use bounded ranges. Viewport rendering alone does not reduce the memory used to store the whole document. Choose the document data structure through measurement; a rope or piece table must still bound retained edits and deleted text.

## One session across devices

The host is authoritative for unsaved text, revisions, undo, active work, and AI/terminal lifetimes. Sharing disk files is insufficient.

Every authenticated paired device has full access immediately: editing and saving, host folders, terminal input, AI settings, requests, and approvals. Keep the PC writable while a phone works. Tag mutations with document revisions and a project generation so a stale or reconnecting device cannot silently overwrite newer work or target a different project. A bounded workspace revision counter prevents close/reopen revision reuse. Retain unacknowledged edits for recovery and present a version choice when devices edit the same revision. Automatic merging and collaborative cursors remain future work; shared access does not require a CRDT or an editor framework.

Internet pairing uses a host-managed, on-demand cloudflared Quick Tunnel. The browser receives an exact temporary HTTPS origin only after the connector registers; a code is generated after the link is ready. The PC remains reachable locally while phones use HTTPS/WSS over another network. Origin validation binds each accepted Host to its matching scheme/authority, secure cookies are scoped to HTTPS requests, and a proxied loopback TCP connection never becomes a local-PC client. Stop and shutdown reap the connector and revoke its public authority. Quick links change on restart and have no uptime guarantee; a configured HTTPS origin supports externally managed permanent tunnels. The connector has a separate measurable RAM cost and stays off until requested.

Network disconnection must leave host processes running. Reconnection restores current document and task state rather than starting duplicate jobs. Persist recoverable document changes with a bounded journal and periodic checkpoints. After a host crash, recover unsaved work and mark interrupted processes honestly; process continuity across a crash cannot be assumed.

## AI integration with existing subscriptions

Codex uses the official app-server integration for conversations, history, approvals, and events. Keep authentication in the supported host-side flow. Current Sign in with ChatGPT guidance covers eligible local personal, open-source, and selected private applications using eligible Plus/Pro allowances, subject to account limits and application eligibility. Commercial or hosted distribution needs the supported authentication route and a fresh eligibility check. Do not promise that every subscription or deployment qualifies.

Claude uses the unmodified official Claude Code CLI, with the user signing into their own account and all supported authentication methods retained. A host adapter can consume documented `--output-format stream-json` output and use `--resume` for session continuity. Avoid `--bare` for this subscription flow because it bypasses subscription sign-in. Do not collect or repurpose Claude authentication tokens or assume an SDK accepts subscription credentials.

AI work belongs to the host session, so its progress, approvals, and results remain available after a device switch. Start provider processes on demand, limit retained output, and expose provider limits and failures accurately. The interface mock must label simulated AI behavior and must not imply that authentication is implemented.

Official integration references, checked during planning on October 9, 2026:

- [Codex app server](https://learn.chatgpt.com/docs/app-server)
- [Sign in with ChatGPT eligibility and usage](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [Codex app-server authentication for open-source applications](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Claude Code legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Code programmatic interface](https://code.claude.com/docs/en/headless)

## Host terminal

Commands execute on the PC hosting the workspace. Start one persistent shell in the workspace directory on first use, attached to a PTY on macOS/Linux or ConPTY on Windows. The host owns that shell, its child processes, working directory, and terminal state. PC and phone browsers attach to the same terminal through the existing authenticated session connection. Hiding its panel, closing a browser, or losing the network leaves the shell running while the host remains alive. Ending the shell is a separate explicit action; a host restart cannot preserve its live processes automatically.

Use this data path:

```text
PC shell ⇄ PTY / ConPTY ⇄ host terminal state ⇄ PC / phone view
```

The host interprets terminal escape sequences into one canonical screen: cells, colors, cursor, modes, normal/alternate screen buffers, and bounded scrollback. Browsers render visible cells and request retained history only when needed. A real interactive terminal needs cursor movement, terminal responses, Unicode widths, alternate-screen handling, paste modes, and correct Ctrl+C/job-control behavior; an append-only command log does not provide that compatibility. Use a small tested parser/emulation core and define its compatibility before advertising a terminal type. The renderer can be custom and lightweight without rewriting every terminal protocol detail from scratch.

Create the terminal on demand. Retain only bounded rows and bytes of scrollback; evict older output instead of keeping an unlimited transcript. Bound terminal dimensions, parser strings, combining-character storage, style/hyperlink metadata, pending input, per-device network queues, and snapshot allocations. Update changed rows in batches and stop browser drawing while the panel is hidden; the host continues consuming and interpreting output. Offer optional disk logs separately, with their own size and rotation limits.

As an arithmetic illustration, an assumed 16-byte cell layout uses 30 KiB for an 80-column × 24-row screen. Two such screen buffers plus 500 additional 80-column rows use about 685 KiB of cell storage. This is an illustration of bounded data storage, not measured terminal RAM: parser allocations, Unicode storage, the host/runtime, browser rendering, transport, OS resources, the shell, and running commands add separate costs. Choose the actual renderer and cell layout through profiling. No total terminal RAM target is established yet.

Keep slow-device backpressure separate from PTY draining. A slow or disconnected phone must not fill an unlimited queue or cause the host to stop reading solely because that device is behind. Coalesce screen updates; if a client's bounded queue overflows, replace its pending display updates with a fresh screen snapshot. Do not discard arbitrary PTY bytes, which can contain control sequences required to interpret later output. If command output outruns even the host parser, bounded buffering can still throttle the producer; unlimited lossless output and guaranteed nonblocking execution cannot both be promised.

Reconnect to the existing terminal ID with a snapshot at a known screen revision followed by newer updates. Avoid retaining/replaying every byte printed since the shell started, and do not recreate the shell on attachment. Every paired device may send keystrokes; fence stale input with the project generation. The device that most recently opens, focuses, or types in the terminal chooses its clamped logical dimensions, and the host resizes both the PTY/ConPTY and its canonical screen. Other devices pan or fit that same cell grid and their passive resize requests are ignored. Unlike the code editor, terminal rows must not be soft-wrapped independently with CSS, because interactive programs use exact cell positions.

UI: keep the terminal hidden by default and expose it from the workspace menu and a keyboard shortcut. On desktop, open a small bottom panel; on phones, use one full terminal surface with access to Ctrl, Esc, Tab, and arrow keys. Closing the surface hides it without ending the host shell. Preserve the editor's quiet default layout. The current working application connects this surface to the host PTY, implements direct raw input and composition handling, and keeps 200 rows of scrollback. The older HTML mock has only simulated commands.

Validate shell input, Ctrl+C, Unicode, cursor movement, alternate-screen applications, resize/handoff, hidden-panel output, sustained output, bounded history, slow observers, reconnect snapshots, explicit process exit, and host failure. Measure terminal infrastructure separately from shells, compilers, dev servers, and AI runners, and also report the total workload.

Primary references checked on October 9, 2026:

- [PTY interfaces and terminal input behavior](https://man7.org/linux/man-pages/man7/pty.7.html)
- [Windows ConPTY creation, communication, and resizing](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- [Terminal control sequences and modes](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
- [Terminal output flow control and producer blocking](https://xtermjs.org/docs/guides/flowcontrol/)

## Human and AI changes

Track each buffer's last saved disk revision. When an AI tool or external program changes a file, compare the new disk content with that revision and the current buffer. Import safe changes into the versioned document history. If both the buffer and disk changed incompatibly, preserve both versions and request a resolution; never silently replace unsaved work.

Keep AI approvals and mutation status visible across devices. Writes should be recoverable, and the host must distinguish an accepted tool operation from a successfully saved file. Session reconnection must not replay destructive actions.

## Memory and access constraints

Bound loaded buffers, undo, terminal scrollback, AI transcripts, caches, queues, and recovery logs. Load language servers and indexing only on request; include their cost in reported figures. Apply backpressure to slow devices and high-volume process output. Avoid one background provider process per tab or device.

Use authenticated device access, protected transport for remote connections, origin checks, and host-side credential storage. Start with local access and an established private tunnel for remote devices. Scope filesystem and command access to the user's authorized workspace. A public unauthenticated editor endpoint is not an acceptable deployment.

## Interface mock

Use one continuous editor canvas with compact floating filename, terminal, and Ask AI controls. Show Save only for unsaved changes. Put files and session/device details together in the floating workspace menu. AI and terminal open on demand as gently raised surfaces, with room for code and no divider grid. Use spacing and typography inside menus and dialogs instead of nested boxes. This follows the user's later game-like UI direction while keeping Zed's quiet density as the reference. On phones, show one main surface at a time; wrap code, keep inputs at 16px, and preserve touch targets and safe areas. Keep focus visible and return it to a visible control when a surface closes. Favor native browser controls, CSS, and minimal dependencies; avoid visual effects that need continuous rendering, extra assets, or blur layers.

Use a gauntlet loop: define visible quality criteria, build a small reviewable mock, have an independent critic inspect it against the criteria, and revise concrete failures. Judge desktop and phone layouts, task clarity, interaction completeness, and avoidable interface overhead. Preserve a clear distinction between simulated interactions and implemented host features.

The interface exploration is now saved in [mockup/index.html](mockup/index.html), with Zed as the user-selected visual reference. [Mock documentation](mockup/README.md) and the [gauntlet record](mockup/GAUNTLET.md) describe its local interactions, review results, and measured source footprint. That directory remains a historical interface prototype. The Rust host now serves the working application from embedded `web/` assets.

## First working vertical slice

1. Serve the custom browser editor from the Rust host; open, edit, undo, and save a supported UTF-8 file.
2. Edit and operate the same host session from PC and phone without manual handoff; preserve conflicting local drafts and reconnect without losing acknowledged edits or duplicating work.
3. Attach a persistent host terminal and integrate one official AI provider, then add the second provider behind the same session model.
4. Recover unsaved changes after a controlled host restart and resolve a deliberately conflicting external or AI file edit.

The demonstration is one continuous task: edit on PC, continue the same unsaved document and AI work on a phone, then return to PC with the shared state intact.

## Acceptance and measurement

Before claiming low memory use, publish the test hardware, browser, build mode, workloads, file limits, and enabled features. Measure idle, editing, device handoff, sustained terminal output, AI activity, and repeated open/edit/close cycles. Report backend, browser, language-server, terminal, and provider-process costs separately, alongside total-system impact where measurable. Account for shared-memory attribution rather than treating summed RSS as exact physical usage.

Track peak and settled memory, memory growth over time, input latency, reconnect time, and recovery behavior. Set numerical release budgets after measuring the first working slice; no RAM or latency figures are established yet.

Verify real iOS and Android input, IME composition, accented characters, emoji, multiline paste, touch selection, keyboard resizing, and scrolling. Functional acceptance requires preserved unsaved changes, safe stale-device handling, visible conflicts, correct provider continuation, and no silent loss of acknowledged edits. The mock is accepted on its interface criteria only.
