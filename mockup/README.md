# Editor interface mock

The editor is named **Nimlo**; this mockup shares its current name and favicon.

Open `index.html` in a browser. It is a self-contained local prototype; it has no installation or build step.

For a local HTTP preview, run from this directory:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://127.0.0.1:8765. Resize the window to explore the phone layout.

## What this demonstrates

- A code-first default view with only a filename/workspace menu and an AI control; Save appears for unsaved changes.
- Sample documents and local editing interactions.
- Provider selection, proposed-change review, and simulated AI replies.
- A device/session control concept and a phone layout.
- A hidden-by-default terminal demo for the PC-hosted shell design.

Click the filename to open one workspace menu containing files, Terminal, and the device handoff demonstration. Ask AI opens the assistant; Close AI returns to code on phones. Save appears only after a file changes and stores sample text in this browser. Keyboard save also works. There are no permanent file panels, tab rows, breadcrumbs, bottom navigation, or status bands.

On phones, code wraps to expose complete lines without a separate scroll-control bar. The desktop retains line numbers and horizontal scrolling. Review Change opens a wrapping diff. Apply refuses to replace a buffer that has changed since the proposal. A temporary message reports actions such as saving; a view-only label appears only after handing off control.

The workspace menu and AI surface label their simulated behavior. Provider authentication, model calls, host filesystem access, real terminals, and cross-device synchronization are not implemented. The complete planned architecture is in [PLAN.md](../PLAN.md).

## Terminal demo

Open the filename menu and choose **Terminal**, or press **Ctrl + backtick**. It opens below code on desktop and occupies the workspace on phones. Close hides it while preserving its demo transcript and running state. Switching to AI and back on phones preserves the terminal view; choosing a file returns to code.

Try `help`, `pwd`, `ls`, `git status`, `cargo check`, `cargo run`, `echo text`, or `clear`. Enter or Run submits a command. Arrow Up/Down recalls up to 20 commands. `cargo run` demonstrates a continuing process; Stop or Ctrl+C interrupts it. Device handoff makes the command input read-only and blocks Run/Stop until control returns.

All commands are simulated in the browser. No shell, compiler, server, or host process is started. The PC-host terminal architecture is specified in [PLAN.md](../PLAN.md).

The demo initializes on first opening, retains at most 100 output rows and 16,384 characters, and limits individual command input to 512 characters. It uses no external terminal package, recurring timer, or background process. These prototype bounds are not measurements of real terminal RAM or a VT compatibility claim.

## Footprint

The interface uses plain HTML, CSS, JavaScript, system fonts, and inline vector icons. The Zed reference images in `review/` are critique material and are not loaded by the interface. The exported screenshots are also not runtime assets.

Actual source-size, network-request, DOM, and browser JavaScript-heap observations are recorded in `review/metrics.json` after browser inspection. A small HTML file and a small JavaScript heap do not establish total browser memory or production editor performance. AI runners and language tools will add their own costs in the real application.

The current version is 28,900 bytes of source (9,161 bytes gzipped), with zero external runtime requests. 46 browser interaction/layout checks passed across `review/checks.json` and `review/terminal-checks.json`.

## Design review

[GAUNTLET.md](GAUNTLET.md) records the selected Zed reference, critique criteria, revisions, and verification. The comparison is limited to this interface brief, not the capabilities or performance of the full Zed editor.

Desktop and phone screenshots are saved as `desktop.png` and `mobile.png`. `desktop-ai.png`, `mobile-ai.png`, and `mobile-review.png` show the optional AI and change-review views.

`desktop-terminal.png`, `mobile-terminal.png`, and `terminal-menu.png` show the terminal and its access point.
