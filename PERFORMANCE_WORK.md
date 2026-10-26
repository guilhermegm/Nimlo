# Memory and performance work

The reference is Nimlo `a811aaf`: its frozen release app, existing editing and
shared-session checks, and the original high-line-count stress workload.
The candidate must reduce measured costs without slower ordinary editing,
lost selections, broken input, draft loss, weaker pairing, or extra idle services.

Builders and a separate critic compare frozen builds and actual measurements.
This file records progress and the evidence used to accept or reject changes.

| Item | Current work | Acceptance evidence |
| --- | --- | --- |
| 1. Whole-app baseline | Frozen release app; native process attribution and workload tooling | Swift, Rust, owned WebKit and optional children identified; footprint/RSS reported separately |
| 2. Bounded editor | Adaptive native input window and document viewport prototype | Global selection, clipboard, Unicode, undo, scroll, keyboard and touch correctness; lower large-file cost |
| 3. Incremental sync | Revision-checked text patches and changed-document recovery | Exact text and durable acknowledgement across concurrent edits, reconnect and restart |
| 4. Retained memory | Aggregate draft, history, inactive-project and cache audit | Bounded retention without evicting pending user text; repeated lifecycle evidence |
| 5. Release gates | Executable budgets and performance checks | Frozen candidate beats the baseline and fails the gate when budgets are exceeded |

All fixtures use temporary projects, fake AI providers and isolated app instances.
Existing user apps, public tunnels and live editor hosts remain untouched.
Physical mobile keyboards cannot be validated by desktop browser emulation;
reports must identify that limitation rather than claim physical-device coverage.

## Implementation and current validation

The adaptive editor is enabled by default above 10,000 lines, including files
that grow across the threshold. The separate critic reproduced and closed
selection, IME, bidi, grapheme, viewport-boundary and promotion regressions in
actual Chromium and WebKit fixtures. Physical OS IME/touch and screen-reader
interaction remain outside automated coverage.

All 131 release host tests pass, including UTF-16 splice validation, per-document
checkpoint reuse, legacy recovery migration, tampered/deleted record repair,
interrupted commit recovery and repeated failed-commit retention. The frontend
source fixtures cover missed-patch recovery, original IME revision and document
identity, cancellation, offline commits and deferred conflicts. Aggregate draft
checks cover successful/failed storage, startup accounting, preserved excess
legacy drafts and paged recovery of deleted/inactive paths.

The native runner freezes numeric budgets before any candidate capture, verifies
same-side binaries/assets and identical diagnostics, rejects compiler/locked
window measurements, and checks every comparison trial and baseline drift.
Synthetic gate rejection tests are distinct from actual memory results.
Both first visible reference trials completed and
cleaned up, but fixed memory/scroll stability checks rejected calibration.
No native candidate was captured and no acceptance bar was loosened. A fresh
quiet pair and valid native comparison remain required. The Mac locked again
before the fresh pair launched. The performance Make target now holds an
external keep-awake process only for its runner's lifetime.

Final native integration also checks Device drafts export through real WebKit
downloads. The fixture caught and fixed a cancellation slot leak. Save-panel
interaction uses a private test destination while locked. A deterministic
keyboard regression covers a queued dialog-close event restoring stale selection
after the user resumes editing or immediately opens a new command menu.

The browser-only comparison retained a guard-limited reference and one complete
candidate. Blind review found substantially lower stress cost but ordinary peer
latency was not at parity. A direct WS probe found about 20 ms extra cost before
the candidate's first broadcast, without supporting the suspected TCP reply delay.
The revised recovery transaction buffers its manifest and links that already
synced inode as the intent marker, reducing six sync barriers to five without
changing the debounce or rollback guarantees. All 131 tests, including long
manifest/legacy-v2, no-prior-checkpoint and marker-removal failure cases, pass.
The unchanged after-probe preserves exact last-ack recovery; median host
acknowledgement remains about 30.7 versus 12.5 ms in the original, so the native
ordinary-edit guard still needs to judge the resulting behavior.
