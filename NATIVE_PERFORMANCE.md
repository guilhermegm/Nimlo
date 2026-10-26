# Native memory and performance

Nimlo uses a release Rust host, a small Swift/AppKit window and the system
WKWebView. It does not bundle Electron or a second Chromium runtime. An idle
native application still has operating-system and WebKit costs; zero RAM is
not a realistic target.

The original signed release at `a811aaf` measured about **85 MiB** in summed
macOS task-charged physical footprint at idle, including its Swift window,
Rust host, owned WebContent, GPU and networking processes. RSS was about
207 MiB and includes shared mappings. Neither sum is an exact measurement
of unique system-wide physical pages. [Original idle evidence](tests/native-performance-baseline-original-idle.json).

## Current local release check

The October 16 local check covers the task-start editor against the updated
editor, with the same final native wrapper on both sides. The immutable
task-start host/assets and SHA-256 identities are preserved under
`target/final-local-performance/baseline`. Run
`caffeinate -d -i node scripts/native-final-performance.cjs` to reproduce it.
The runner freezes its quality rules before measurements and performs
baseline/candidate/candidate/baseline trials. It includes near-1 MiB ASCII and
Unicode files with few long lines, tail edits, ordinary files, high-line files,
paired editing, scrolling and ten open/close cycles. Native timing requires a
visible window; explicit diagnostic windows float above ordinary applications
to reduce WebKit frame throttling. A normal Nimlo launch keeps its usual window
level and creates no diagnostic controller.

The standalone WebKit editor diagnostic completed five trusted keyboard samples
per case at the end of each file. Median keydown-to-two-frame time was
962 → 25 ms for the near-1 MiB ASCII line, 119 → 28 ms for the few-line Unicode
file, and 28 → 29 ms for ordinary text. These are isolated editor measurements,
not whole-app memory or physical display latency claims. Source hashes and all
observations are in `target/final-local-performance/lowline-eof-webkit.json`.
The complete native build-2 workload passed correctness, including 53 keys,
16 scroll movements, ten open/close cycles and recovery. Its Unicode cold key
was 192 ms, exceeding the fixed 150 ms limit. Task charges were about 85 MiB at
idle, 278 MiB after Unicode editing and 230 MiB after the later open/close cycles.
The 0.2.1 buffer-retention fix removes an unnecessary native value replacement;
it does not establish a RAM saving. The native measurement and independent
qualification remain separate from the normal regression pass. An unexplained
cursor failure in an earlier run did not reproduce with pointer-interference
checks; it is not claimed as a product bug corrected by this change.

The final 0.2.1/build-3 native workload also completed correctly, with all owned
processes cleaned up and no compiler processes observed during measurement.
Observed worst native dispatch-to-two-frame times were 37 ms for ordinary local
typing, 24 ms for paired ordinary typing, 57 ms for the ASCII tail, 177 ms for
the Unicode tail, and 41 ms for the high-line file. **The Unicode result still
fails the fixed 150 ms timing bar.** The buffer-reset fix must not be described
as resolving that remaining latency issue.

Settled native task-charge sums were about 86 MiB idle, 156 MiB during ordinary
editing, 285 MiB after Unicode editing, 231 MiB two seconds after closing that
file, and 232 MiB after ten later open/close cycles. These observations show
retained/high-water memory and do not establish a RAM saving, a leak, or an
exact unique-memory total. The separate sum of task lifetime peaks is not a
simultaneous app peak. Native evidence is in
`target/final-local-performance/native-build-3.json`; correctness completion and
performance qualification are separate outcomes. This local result supports a
manual-install preview, while the cold Unicode cost and retained memory remain
concerns for a broader release marketed on low resource use.

## Historical release gate

The earlier comparison against `a811aaf` remains unqualified. Its first two complete
visible reference runs failed the fixed stability limits
(idle charges about 111.5 versus 90.0 MiB, high-line scrolling worst observations
47 versus 37 ms). Both reports remain preserved; no numeric budgets were accepted
from them. The Mac locked again before the next pair started; that attempt
launched no app. A fresh quiet reference pair must pass before that historical
gate can qualify a candidate. The current task-start comparison does not replace
or claim to pass its distinct 30% memory-reduction requirement.
Earlier instrumented baseline observations and rejected runs remain in
`tests/native-performance-*.json`; they are diagnostic evidence rather than
accepted final calibration. A compiler, occluded/locked window, inconsistent
artifact or incomplete cleanup causes the release gate to fail.

## What changed

- Files above 10,000 lines or 65,536 UTF-16 units use a custom visible viewport
  and native input window bounded to 160 lines and 8,192 UTF-16 units. Read-file
  pages remain bounded to 65,536 units. Sparse line offsets replace a full
  line-string array in this mode. Typing/pasting across the threshold promotes
  the document; shrinking restores the ordinary native control.
- Sparse glyph-width checkpoints preserve unchanged prefixes when editing long
  Unicode lines. The cache holds at most 16 lines and 128 measured glyph widths.
  A retained native buffer that contains the line's complete suffix stays in
  place when caret scrolling moves past its measured right edge. Scrolling left
  or beyond a buffer with more text to its right still recenters it.
  Undo eviction favors the most recently edited document while retaining the
  existing 2 MiB aggregate history and 20-entry per-document limits.
- Global selections, Unicode/grapheme navigation, bidi cursor movement, clipboard
  operations and shared undo retain document offsets. Native touch selection
  covers the displayed range. Read file provides bounded pages, line navigation
  and whole-file Select all without a hidden giant textarea.
- Revision-checked UTF-16 splice messages carry changed text. A missing base
  requests a fenced snapshot; older peers can keep using full-file events.
- Recovery streams only changed immutable document records. A small atomic
  manifest identifies them; unchanged records share references. Checksums,
  metadata repair, private files and an interrupted-transaction journal protect
  previously acknowledged text. Legacy snapshots migrate without dropping drafts.
  The synced manifest also serves as the transaction marker through a hard link;
  buffered serialization and that shared inode remove redundant writes and one
  file sync, retaining all three directory barriers before acknowledgement.
- Device drafts share a 32-record / 8 MiB serialized UTF-16 storage budget across
  projects. Failed storage writes keep their only pending copy in RAM. Growth
  waits when capacity is full; saved text is never automatically evicted. Session
  → Device drafts offers paged download/discard for inactive or deleted files.
  The native app streams a requested recovery copy through WebKit and a Save
  panel to a new filename. Cancelling releases the transfer; existing files
  remain untouched. This adds no page-accessible filesystem bridge.
- Host buffers/history, conversations, terminals, connection queues and inactive
  project metadata retain their existing aggregate bounds. The normal app adds
  no performance sampler, helper process or polling timer.

## Reproduce the release gate

```sh
make test-performance-core   # correctness and synthetic gate checks
make performance-plan       # no launch, build, capture or file changes
make test-performance       # builds, freezes and measures the native release
```

`make performance-baseline` prepares the original reference app separately.
`PERFORMANCE_BASELINE_REF=a811aaf` selects the reference commit. A fresh checkout
builds that reference from an owned temporary Git archive using cached Cargo
dependencies, then preserves the signed original app and its source/asset hashes.
The candidate is copied to a unique `target/performance-runs/<id>/candidate`.
Existing frozen artifacts are validated and never silently overwritten.

Use an unlocked, awake Mac and a quiet machine with no compiler jobs. Node,
Playwright, Chrome and the macOS SDK/diagnostic tools are development dependencies;
they are not part of the shipped app. Configure `PLAYWRIGHT_PATH`, `CHROME_PATH`
and `NIMLO_WS_MODULE` when their local defaults are unavailable. Keep the desktop
visible until the run completes. Reports, frozen numeric budgets, anonymous
comparison data and failures remain under the unique run directory.
The Make target uses an external, test-only `caffeinate -d -i` process for the
runner's lifetime to prevent display and idle system sleep. It does not change
settings or unlock a locked session; its cost is harness overhead, outside the
owned native app's reported process charges.

The runner records two valid reference trials and freezes numerical budgets
**before candidate measurements**, then runs reference/candidate/candidate/reference
serially. Every candidate trial and every reference drift check must pass.
The [budget model](scripts/native-performance-budget-model.json) fixes these rules:

| Outcome | Required result |
| --- | --- |
| Idle and ordinary memory/input | Bounded parity; unstable calibration is rejected |
| Large-file WebContent lifetime peak | At least 30% lower |
| Whole native stress footprint and lifetime peak charges | No allocator-shift increase |
| Retained large-file excess above each run's idle | At least 30% lower, using the conservative reference minimum |
| Raw retained/cycle totals | Bounded parity, including a separate idle guard |
| Large-file native input and shared acknowledgement/render | At least 25% faster |
| Ordinary and large-file scrolling | Bounded parity and stable reference observations |

Natural garbage collection can vary. Retention is reported as both raw task
charges and excess over idle; the gate cannot inflate idle or noise allowances
to manufacture a win. A zero reference excess establishes no percentage saving.
Synthetic tests verify that bad latency, memory tradeoffs, invalid references,
changed instrumentation and incomplete workload counts are rejected.

The supplemental browser diagnostic completed the candidate but stopped the
original at its 3 GiB RSS safety guard after two of three stress keys. Its blind
review found a strong completed stress advantage and slower ordinary shared
updates; it is neither a complete retention comparison nor native acceptance.
Direct RPC probes localized an additional host cost before the first broadcast.
After the linked-marker change, candidate whole/patch acknowledgements measured
about 30.7 ms median versus 12.5 ms for the original in that run. The unchanged
probe checks exact last-ack recovery after SIGKILL. It excludes browser rendering
and debounce and does not establish hardware power-loss behavior or causation
for individual disk operations. [Before](tests/recovery-latency-before.json),
[after](tests/recovery-latency-after.json).

## Workload and interpretation

The native suite uses ordinary 1,000-line source, eight ordinary open files,
one near-1 MiB file with about 209,000 lines, an authenticated paired browser,
ten open/close cycles and a page-reload recovery phase. Optional host shell and
fake AI work are measured separately. Real inference requests and internet tunnels
are zero; temporary projects and exact owned process identities isolate the test
from existing apps, live hosts and user files.

AppKit sends trusted native key events. Native dispatch-to-frame-callback timing
includes IPC and uses two animation-frame callbacks as a rendering proxy; it does
not measure the moment pixels reach the display. The paired barrier waits for the
acknowledgement and both renderers. Ordinary input uses 12 local and 12 paired
samples, judged separately by the **observed worst of 12**, not a population
percentile. High-line input reports the **observed worst of three**; each
low-line tail case uses 12 keys. The original six-key stress trial exceeded its
safety guard; three keys are
identical on both sides. Eight viewport movements per scenario test scrolling.

Each native task is attributed to the owned fixture, including WebKit XPC
processes; paired Chrome costs are reported separately. Task charges, RSS,
natural JavaScript heap and explicit Chromium-GC diagnostics remain separate.
WebKit has no forced-GC measurement here. Full-source probe snapshots are excluded,
and equal diagnostic overhead is present on both sides. Measurements are specific
to this hardware/workload and do not prove indefinite memory stability.

Host crash recovery is checked separately by killing the temporary host after a
durable acknowledgement. Page reload is a distinct workload. Automated editor
checks run in Chromium and WebKit and include native reference comparisons,
mobile-sized viewports and synthetic composition events. Physical OS IMEs,
phone selection handles, real clipboard integration and screen-reader interaction
still need physical-device validation.

[Native export checks](tests/desktop/native-download.json) exercise the actual
embedded Device drafts UI and WebKit Blob transport, exact Unicode output,
cancel/retry and recovery-copy preservation. A private test destination replaces
the Save panel while the host is locked; physical Save-panel interaction is
outside that automated proof.

The earlier browser workloads and their historical figures remain in
[PERFORMANCE.md](PERFORMANCE.md). `make test-performance-browser` runs the earlier
browser measurement script; it does not replace the native release gate.
