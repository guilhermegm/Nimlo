# Release measurements

Measurements and recorded harness hashes below refer to their recorded revisions; current commands use `NIMLO_BINARY`.

The October 12 native baseline, bounded-editor work and release-gate status are
documented in [NATIVE_PERFORMANCE.md](NATIVE_PERFORMANCE.md). Figures below belong
to their named historical builds.

## Saved file unloading — October 16, 2026

Saved, inactive documents now release their source text and undo/redo history.
Each project keeps its active document and unsaved or conflicting documents;
recent files retain at most 32 paths and 16 KiB of path text. The current browser
also releases inactive editor, search, typing and replacement-review references.
Reopening a shortcut validates and reads the file from disk with a fresh revision.
Recovery persists the paths and revision clock without requiring inactive clean
buffers to stay loaded. Pending device edits and IME input remain protected.

`make test-lazy-files` checks the real embedded UI and host using disposable
projects; use `BROWSER=webkit` for WebKit. Its retained-source measurements describe
document buffers, not total process memory or immediate operating-system page
reclamation. The app's WebView, native shell and optional running tools still use
memory.

Both engines passed nine lifecycle checks. Visiting forty 256 KiB files (10 MiB
of source text) left one 256 KiB document loaded in each host and client, with 32
path shortcuts. A separate restart case restored the active file and two unsaved
files. Shared-request and composition races preserved pending text; composition
events were simulated, so these checks do not qualify physical input methods.

## Keyboard navigation — October 11, 2026

Release `c7744c1b6b73bd8813e43c45d896f7a182bdb8955199c9018c867e09b88596b2` adds keyboard commands and optional Vim-style movement without a runtime dependency, background indexer, worker or polling loop. The picker makes one directory request at a time, shares the existing bounded directory metadata, creates at most 80 result rows, and releases its rows and folder reference on close. It never recursively scans projects or reads file contents for suggestions. Vim movement retains no second document index or line array. The existing large native-textarea limitations remain.

The executable is **3,023,152 bytes**. Embedded HTML/JS/CSS total **220,752 bytes**, with a **51,701-byte offline gzip estimate**. Against the AI chat release below, this adds 16,512 executable bytes, 18,763 browser-source bytes and 4,605 estimated gzip bytes. No new runtime-memory or latency benchmark was run; these sizes and rendering limits do not establish a RAM reduction or a speedup.

## AI chat correction — October 11, 2026

Release `d42464ec1dab8f447a850ec77cfc31c8e89ae80ea238e6bdd7e728b440cab851` adds readable approvals, explicit AI permission modes and a small DOM-based Markdown renderer. It adds no runtime package, font, image, language server, worker or resident process. Formatting shares a budget of 1,800 nodes across the visible transcript, then displays the remaining text without formatting. Transcript storage remains bounded at 60 KiB / 128 messages; approvals remain bounded at eight with 2 KiB action previews. Hidden AI surfaces do not rebuild messages, and the renderer retains no Markdown AST or secondary transcript cache. Open approval disclosures and focus are preserved from the current bounded DOM when streaming updates rebuild it.

The stripped executable is **3,006,640 bytes**. Embedded HTML/JS/CSS total **201,989 bytes**, with a **47,096-byte offline gzip estimate**; HTTP responses remain uncompressed. Compared with the preceding pairing release, this adds 82,928 executable bytes, 17,139 browser-source bytes and 4,613 estimated gzip bytes. These are artifact measurements, not runtime RAM measurements. The independent browser review includes a hostile long-Markdown rendering bound; no new total-memory or latency benchmark was run for this change. The retained-JavaScript savings and extreme native-textarea costs below still describe their own measured builds.

## Current memory gauntlet — October 11, 2026

The independent gauntlet accepts release `82cd887065a0422bc0e898f0e42c52d69951dd27361d38033ffe171168c6372e` for **repeated retained-JavaScript savings, shared host snapshots and reliable rapid typing**. It does not establish near-zero total RAM, uniformly lower host/browser memory or a causal speedup. The reference is the frozen task-start release `e089dc02…`; historical figures below belong to their own builds.

The shipped host shares immutable document text across history, conflict, view and rollback snapshots instead of copying it. The browser retains one active document's line array, releases it immediately on document/project changes and background hide, and rebuilds it when needed. Native textarea updates, size validation, syntax rendering and active-edit allocation behavior remain as in the reference. A deterministic regression also fixes a duplicate-send race that could make rapid typing conflict with its own acknowledged revision. File, history, recovery and project limits remain unchanged. There is no new runtime dependency, process, indexer or language server.

The independent critic rejected two earlier candidates, then ran the final candidate twice with the preserved original workload and once with a focused paired-rendering workload. The original workload includes two actual app clients, an ordinary 1,000-line file, eight near-limit files totaling 7.992 MiB, native typing and scrolling, repeated whole-document replacement, disk conflict, directories, close/reopen, a shared disposable PTY and fake conversation, and recovery after restart. Both providers are fake local fixtures; no real inference or public tunnel is included.

| Final comparison | Baseline, two original trials | Accepted candidate, two original trials |
| --- | ---: | ---: |
| Retained desktop JS heap at eight loaded files | 16.542 / 16.542 MiB | 14.428 / 14.428 MiB |
| Retained phone JS heap at eight loaded files | 16.524 / 16.524 MiB | 14.410 / 14.410 MiB |
| Fresh idle host RSS, no browser or children | about 4 MiB | 4.063 / 4.031 MiB |
| Ordinary-file host OS physical footprint | 9.376 / 8.860 MiB | 7.017 / 6.907 MiB |
| Directory-metadata host OS physical footprint | 76.1 / 69.5 MiB | 63.9 / 62.2 MiB |
| Recovered-session host OS physical footprint | 59.2 / 61.2 MiB | 51.1 / 48.7 MiB |
| Observed host OS physical-footprint peak | 77.1 / 80.5 MiB | 63.9 / 77.2 MiB |
| Sampled host RSS peak | 60.688 / 72.969 MiB | 75.344 / 88.406 MiB |

The **12.8% retained-JS reduction** repeats on both devices and in the focused comparison. It is a specific eight-file result after forced garbage collection, not a reduction in total browser RAM. Host snapshot copy elimination is deterministic; lower footprint recurs in the ordinary, metadata and recovered-session phases, while some large-file phases use more memory. Candidate RSS peaks are higher, and the second physical-footprint peak overlaps the baseline range. After the stress workload and browser closure, candidate host RSS remains 51–54 MiB rather than returning to its fresh-process 4 MiB. These readings do not support a uniform host memory claim.

Both final full-workload trials pass all ten workflow checks; all three final broad/focused sustained-typing probes pass. The earlier repeated large-file slowdown is absent. Focused paired 16-key batches take 24.29 / 23.00 seconds versus the reversed baseline's 23.32 / 23.29 seconds, including native rendering and shared-state barriers on an extreme 209,000-line file. Ordinary-file handlers remain sub-millisecond, but that excludes native preprocessing, rendering and acknowledgement. Results support performance parity on this machine, not a universal speed or latency guarantee. A 44.9 ms handler-tail outlier in the first final trial does not recur in the second.

The exact accepted build passes **106 Rust tests**, formatting, strict Clippy and **213 embedded release checks** across Chromium, WebKit, editing, projects, terminal, setup, security and pairing. Independent native shrink→regrow selection/scroll comparisons and cache-lifecycle checks pass. Dispatched composition events and desktop-hosted phone emulation do not validate operating-system IMEs or physical-phone behavior. [Functional validation](tests/performance-root-validation.json) is a preserved earlier snapshot; the subsequent [final critic verdict](tests/performance-gauntlet-final-verdict.json) records the scoped acceptance. [Final trial 1](tests/performance-gauntlet-third-original-1.json), [final trial 2](tests/performance-gauntlet-third-original-2.json), [focused final trial](tests/performance-gauntlet-focused-third-1.json) and [reversed focused baseline](tests/performance-gauntlet-focused-baseline-2.json) retain raw evidence. All 157 recorded fixture Chrome processes exited.

The stripped release executable is **2,907,200 bytes**. Embedded HTML/JS/CSS total **179,484 bytes**, with a **41,425-byte offline gzip estimate**; responses remain uncompressed. Compared with the reference, this adds 16 executable bytes and 777 browser-source bytes. These artifact sizes do not measure runtime RAM.

These are single-machine observations on an M1 Pro Mac with 32 GiB RAM and Chrome 155. Other application activity and substantial existing swap are uncontrolled. `ps` RSS is sampled rather than an exact peak; macOS physical footprint includes compressed allocations and differs from RSS. Forced-GC retained JavaScript heap excludes native textarea DOM/layout, browser infrastructure and GPU allocations. Renderer-category RSS can contain shared pages; it is neither per-page physical RAM nor additive with JS heap. The original sampler uses synchronous `ps`, which can add driver delay. The focused comparisons use asynchronous sampling and both renderers. Final broad trials occur after the original baseline trials, so reverse-order focused measurements help identify drift without establishing statistical confidence or causal speedups.

### Rejected iterations

The first candidate shares immutable host text, replaces retained split-line arrays with a sparse active-file index, reuses unchanged visible syntax markup and avoids an encoded full-file validation copy. Four serial trials run in baseline–candidate–candidate–baseline order with frozen binaries, identical fixtures and the same measured harness.

| First comparison | Baseline, two trials | First candidate, two trials |
| --- | ---: | ---: |
| Retained desktop JS heap at eight loaded files | about 16.54 MiB | about 10.45 MiB |
| Retained phone JS heap at eight loaded files | about 16.52 MiB | about 10.43 MiB |
| Observed host OS physical-footprint peak | 77.1 / 80.5 MiB | 69.4 / 70.8 MiB |
| Complete workload wall time | 314.6 / 343.4 s | 385.6 / 496.0 s |
| Median 16-key large short-line batch | 14.64 / 10.54 s | 28.37 / 32.18 s |
| Median full-document replacement | 2.20 / 1.57 s | 2.52 / 2.84 s |

**The critic rejects this first candidate as an overall performance win.** The approximately 37% retained-JS saving and lower observed host footprint do not excuse slower large-file operations. Native renderer RSS does not show a stable reduction, and scrolling improvements from the first baseline alone do not recur against the reversed baseline. Ordinary-file event-handler medians remain sub-millisecond in these trials; handler execution excludes rendering, network, persistence and acknowledgement latency.

The first candidate is `74b4da5e…`; all four artifacts record complete binary/asset hashes. The exact measured script is [preserved here](tests/performance-gauntlet-measured-harness.cjs). [Baseline 1](tests/performance-gauntlet-baseline-1.json), [candidate 1](tests/performance-gauntlet-candidate-1.json), [candidate 2](tests/performance-gauntlet-candidate-2.json), [baseline 2](tests/performance-gauntlet-baseline-2.json), and the [independent first verdict](tests/performance-gauntlet-first-candidate-verdict.json) retain results and limitations. Calibration and process-observer failures are separate artifacts and do not count as accepted trials.

The second candidate `821426c8…` adds passive remote display coalescing. An initial [controlled proof](tests/performance-gauntlet-coalescer-independent-proof.json) passes, but a further [native shrink→regrow test](tests/performance-gauntlet-selection-proof.json) finds stale selection and scroll instead of the reference's native clamping. Natural steady typing also makes sixteen phone assignments for sixteen keys, despite a controlled burst demonstrating batching. The candidate is rejected. Its initially higher renderer RSS does not recur consistently against the reversed baseline, so it is not attributed causally to this code. The final candidate discards coalescing, sparse indexing, the UTF-8 fast path and markup caching, and [passes the same native comparison](tests/performance-gauntlet-third-selection-proof.json).

### Next improvements and reproduction

The largest remaining architectural limit is the full native textarea. A valid near-1 MiB file containing about 209,000 short lines retains roughly 420,000 native DOM nodes per page after GC. Repeated native replacements produce **2–8 GiB combined isolated-renderer RSS** across the focused variants, including the reference. This is severe stress behavior and shared-page-inclusive RSS, not exact physical RAM. Chromium's [text-control implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/forms/text_control_element.cc) constructs native text and line-break nodes when replacing the inner editor value; this current-main source explains a plausible mechanism, rather than attributing exact installed-Chrome allocations. The next worthwhile changes are:

1. A bounded native input window with a custom visible document viewport. Prove global selection, clipboard, IME, touch editing, accessibility, undo and scroll restoration before replacing the current editor.
2. Incremental authenticated document synchronization and changed-document recovery persistence, preserving revision fences and durable acknowledgements. Measure whether they remove the large-file wait before promising a gain.
3. Repeatable release checks for ordinary input latency, paired rendered latency, native browser memory, reconnect and long-session retention. Include real phone measurements and optional connector/provider processes as separate workloads.

Run `node scripts/performance-editor-check.cjs` for the deterministic concurrent-send regression. The [final verdict](tests/performance-gauntlet-final-verdict.json) provides exact commands, binary hashes and instrumentation limits for the original and focused workloads. The original [measured harness](tests/performance-gauntlet-measured-harness.cjs) has SHA-256 `50a6a8137034292098f365dd5720d87303ac5443f2b462c8d6334eacf48c95f2`; the recorded [focused harness](scripts/performance-gauntlet.cjs) had SHA-256 `08ba070fe374c5049ae30b0ba8223a912bcd20ed7f16f3614cba3af07d1d99ed`. Supply `NIMLO_BINARY`, `PERFORMANCE_BINARY_SHA256`, `PERFORMANCE_ASSET_MANIFEST` and `PERFORMANCE_OUTPUT` for a frozen build; use `PERFORMANCE_FOCUSED=1` for the focused run. These development tools and rejected-source diagnostics are not embedded in the application.

## Historical floating-interface measurement — October 9, 2026

The older measured Rust host used **3.6 MiB RSS when initially idle** and reached **44.1 MiB observed peak RSS** during a 92.6-second run with two browser clients, eight near-limit files, repeated edits, handoff, terminal output, and reopen cycles. This historical build includes the earlier floating interface and project and AI Settings. Browser JavaScript heap is reported separately; these figures do not establish total browser or system RAM or the current release's memory. This is one measured run, not a release memory guarantee.

## Conditions and reproduction

This heavy-workload benchmark is historical and describes the floating-interface build identified below. The multi-project revision is measured separately at the end of this report. Its heavy file-editing workload has not been rerun.

- Measured October 9, 2026 on an Apple M1 Pro MacBook Pro (`MacBookPro18,1`), 32 GiB physical RAM, macOS 26.2 build 25C56, Darwin 25.2.0.
- Rust 1.99.0; release profile uses stripping, thin LTO, and one codegen unit. Node 20.17.0 drives Playwright and installed Chrome 155.0.8059.39 in headless mode.
- A separate release host bound to `127.0.0.1:0` owns a generated temporary workspace and recovery directory. No LAN exposure or AI inference was part of this benchmark. Startup account-status probes had finished before the initial idle sample; no child processes remained then.
- Actual app pages use separate desktop (1280 × 800) and phone (390 × 844, touch/mobile emulation) browser contexts. Phone emulation runs in desktop Chrome; it is not a physical iOS or Android measurement.
- `ps` samples the host's resident set approximately every 100 ms. Each phase settles for 1.5 seconds; the reported settled value is the median of its final ten RSS samples. Peaks are sampled observations and can miss shorter spikes.
- Chrome CDP `Runtime.getHeapUsage` records each page's JavaScript heap before and after an explicit `HeapProfiler.collectGarbage`. The pages include small benchmark instrumentation. These values exclude browser native allocations, text layout, GPU memory, browser infrastructure, and other processes.
- Independent UI regression checks ran concurrently in separate fixtures. System load and memory pressure were not controlled.

Run from the repository root:

```sh
cargo build --release
PLAYWRIGHT_PATH=/path/to/node_modules/playwright \
CHROME_PATH=/path/to/chrome \
node scripts/performance-check.cjs
```

The [benchmark script](scripts/performance-check.cjs) has local defaults for the installed Playwright and Chrome used here. It checks that the binary's served assets match the current source hashes, authenticates and pairs the two app pages, and removes its temporary workspace afterward. It never writes the launch token to results. [Raw final measurements](tests/performance.json) include build hashes, phase samples/counts, browser heaps, child-process observations, and cycle readings.

## Host and browser results

The workload opens eight ASCII UTF-8 files of 1,047,552 bytes each: 7.992 MiB loaded text. It makes twenty complete-document replacements, transfers the same unsaved session to the phone, starts an 80 × 24 terminal, prints 5,000 lines with a requested 1 ms pause per line, requests retained history, and performs ten cycles of closing and reopening all eight files. The terminal retained 200 history rows. The terminal opens on the phone; the AI panel remains closed and no inference runs.

Project switching, restart recovery, and AI configuration have separate functional checks. Their repeated-use memory costs are not measured by this workload.

Values below are MiB. Browser columns are **used JavaScript heap after forced GC**, not browser RAM.

| Phase | Host settled RSS | Host observed peak | Desktop JS heap | Phone JS heap |
| --- | ---: | ---: | ---: | ---: |
| Initially idle; no browser or terminal | 3.6 | 3.6 | — | — |
| One desktop; no files | 3.8 | 3.8 | 1.3 | — |
| Desktop and phone; no files | 4.2 | 4.3 | 2.0 | 2.1 |
| Eight near-limit files | 21.1 | 21.1 | 12.7 | 10.1 |
| Twenty full-document edits | 38.8 | 42.3 | 13.7 | 10.1 |
| Handoff to phone | 38.8 | 38.8 | 13.7 | 10.1 |
| Persistent terminal, idle | 39.6 | 39.6 | 13.7 | 10.3 |
| 5,000 terminal lines and retained history | 41.8 | 41.8 | 13.8 | 10.4 |
| Ten close/open cycles | 29.3 | 44.1 | 12.8 | 10.4 |
| All files closed; shell explicitly stopped | 29.5 | 29.5 | 3.2 | 2.3 |
| Browsers closed; host remains running | 29.7 | 29.7 | — | — |

The largest phase-final desktop heap reading **before** forced GC was 59.4 MiB after the edits, versus 13.7 MiB afterward. Intermediate browser heap peaks were not sampled. Forced-GC figures therefore describe retained JavaScript data under this measurement method, rather than ordinary live browser memory.

Host cycle readings were 41.80, 44.02, 43.84, 43.56, 43.56, 39.58, 37.53, 37.16, 29.31, and 29.31 MiB. RSS remained about 29.7 MiB after files, terminal, and browsers closed; it did not return to the fresh-process baseline. Heap profiling was not performed to attribute those remaining resident pages. Ten cycles do not prove long-term stability or behavior under every valid input.

One automated handoff completed in 26.7 ms, including Playwright observation. This single sample is not an input-latency or network-latency guarantee. Sustained typing, reconnect latency, high-latency networks, and eight simultaneous devices still need dedicated measurements.

## Separate process costs and exclusions

The terminal's `/bin/zsh` process used 7.3 MiB RSS at its idle phase and reached 7.5 MiB in sampled output-generation observations. The Python 3.14 output producer reached 14.8 MiB RSS. These child processes are excluded from the host column. They depend on the user's shell configuration and command workload.

Provider inference processes, language servers, compilers, development servers, browser process RSS, and total-system physical memory were not measured here. No language server or indexer is started by this implementation. Separate live subscription requests established functional AI integration during the build, but do not establish AI memory costs. RSS can include shared pages, so adding process RSS values would not give exact physical-memory usage; adding these host RSS and JavaScript-heap columns would also give an incomplete total.

## Change driven by measurement

The first release benchmark exposed excessive transient copies in recovery persistence. It copied every open document, constructed another complete JSON value, and allocated an entire serialized output buffer. Recovery now streams borrowed document fields through a 16 KiB buffered writer to the same atomic, durable checkpoint. Final validation passed all 47 locked crate tests, including recovery, conflict, limits, filesystem, project switching, AI settings, and terminal tests; formatting and strict full-target Clippy checks also passed.

The heavy phases were rerun with the same workload. The floating interface, project and AI Settings, frontend correctness changes, and terminal resize fixes also landed between builds; the raw artifacts preserve each build's binary and asset hashes. These are single before/after observations, not statistical performance trials or an isolated attribution of every difference to recovery streaming.

| Host measurement | Before streaming checkpoint | Final build |
| --- | ---: | ---: |
| Eight near-limit files, settled RSS | 105.6 MiB | 21.1 MiB |
| Twenty edits, settled RSS | 239.5 MiB | 38.8 MiB |
| Ten reopen cycles, settled RSS | 336.3 MiB | 29.3 MiB |
| Entire run, observed peak RSS | 380.2 MiB | 44.1 MiB |

[Before-change measurements](tests/performance-before.json) are retained for review. Idle disk polling also checks metadata signatures before reading file content; a regression test confirms unchanged polls do not read or copy document buffers. Save still validates disk content.

An [earlier floating-interface trial](tests/performance-floating-before-polish.json) is also retained under its own build hash. It predates the final phone controls and file-menu polish; it is not a repeated trial of the final binary.

## Artifact sizes and explicit bounds

The measured stripped release executable is **2,559,680 bytes (2.44 MiB)**, including the browser assets. Its SHA-256 is `5c9191bbb471f5f845be1740b7fff8c42a0efde76e86247ee114c705798e6c63`. That build's three browser source assets total **89,973 bytes (87.9 KiB)**:

| Asset | Source bytes | Gzip estimate |
| --- | ---: | ---: |
| `index.html` | 14,321 | 3,967 |
| `app.js` | 53,798 | 13,892 |
| `style.css` | 21,854 | 5,109 |
| Total | 89,973 | 22,968 |

Gzip sizes are offline estimates; the host serves these assets without response compression. There is no editor framework, package bundle, or CDN dependency in the browser.

The original measured build used the following retained-data limits, separate from RAM budgets. The multi-project revision’s current limits are described below:

- Files: 1 MiB each, eight open documents, 8 MiB current text, 2 MiB shared undo/redo, at most twenty history states per document. Preserved disk-conflict text can add up to another 8 MiB.
- Recovery: one private checkpoint with a 128 MiB encoded-size cap, accommodating worst-case JSON escaping. It is streamed through a 16 KiB buffer; interrupted checkpoint temporary files are cleaned on startup.
- Terminal: up to 200 columns × 80 rows, 200 history rows, 64 KiB pending input, and bounded control strings/replies. Parser buffers, allocations, and running commands have additional costs.
- AI: one active job, 60 KiB retained message text, 128 messages, eight pending approvals, bounded protocol lines and previews. Provider processes and provider-managed storage are separate.
- Network: eight connected devices, sixteen physical connection slots during replacement, bounded/coalesced notifications, and bounded messages and write buffers. Slow-peer sends time out; these bounds do not imply tiny allocations under every workload.

This report establishes observed release behavior on one Mac and one emulated phone layout. It does not claim near-zero total RAM, Windows validation, physical-phone validation, exhaustive slow-client behavior, or an established numerical release budget.

## Internet connector observation — October 10, 2026

The optional managed internet feature uses one `cloudflared` process only while enabled. It remains separate from the Rust host and is stopped/reaped when internet access is turned off or Nimlo exits. Local-only operation does not start it.

A live public HTTPS/WSS fixture on release `2f244e1f6953595477ef03d7258c906f35c93b44569eaae0b6d02af634973d21` observed **5.48 MiB host RSS** and **44.45 MiB connector RSS** after a small file edit/save, a real shell command, browser pairing, and reconnect. This is one process RSS sample, not an idle measurement, peak, stable budget, or total physical-memory attribution. Browser and shell costs are excluded. It must not be compared as the same workload as the earlier heavy benchmark. The full heavy benchmark was not rerun for this feature.

[Raw live-network result](tests/internet-live.json) and [reproduction script](scripts/internet-live-check.cjs) record the exact build and method. This implementation buys working HTTPS internet transport through an existing connector; it does not claim near-zero memory for internet access.

## Multiple-project and active-project measurements — October 10, 2026

The multi-project release with explicit current-project controls and PC-entry recovery was measured separately with `node scripts/multi-project-check.cjs`, using real disposable hosts, authenticated PC/phone WebSockets, small generated files, an actual disposable shell and local fake provider processes. No browser, public tunnel or inference runs in this measurement. The same Mac ran other browser regressions concurrently, so system load and memory pressure were not controlled. Each host RSS figure is the median of seven `ps` samples 80 ms apart after a 250 ms settling period. Startup account-status probes finished before idle samples, and all three measured phases had zero remaining host child processes. No peak was measured. The preceding PC-entry release `be6aba5619d919be48752b115c48fe998bd8f103b9bdcc6a09d5968290a51c4b` measured 3.97/5.53/4.42 MiB in the corresponding phases. These separate runs do not establish a causal allocation change or a memory reduction.

Release SHA-256: `cc68e787492d20bf2c2e39c53ddfa64e9e474475fa9f1f2f44688536293d71d3`. The stripped executable is 2,907,184 bytes (2.77 MiB), including the browser assets.

| Measured phase | Host RSS (MiB) | Host children |
| --- | ---: | ---: |
| one idle project | 4.31 | 0 |
| 32 attached empty or small visited projects, no running work | 5.55 | 0 |
| restart with 32 remembered projects | 4.44 | 0 |

The one-project and restarted 32-project samples show that remembered roots can remain light metadata without launching a shell or provider for each folder. They are different host processes in one run, not a controlled per-project allocation experiment or a guaranteed overhead. The middle sample follows editing, PTY and fake-AI work and retains an acknowledged dirty draft; its difference cannot be attributed solely to project attachment. Browser native memory, browser JavaScript heap, terminal programs, provider CLIs and the optional internet connector are excluded. These figures do not replace the historical heavy-file benchmark above.

Current retained-data bounds apply across the session: 32 attached roots, eight open UTF-8 documents of at most 1 MiB each, 8 MiB current source and 2 MiB undo history. Preserved disk-conflict text can add up to another 8 MiB. At most eight explicitly started PTYs and four active AI jobs (one per project) run concurrently; each retained shell and conversation has its own bounded screen/history or transcript. Stopped shells and completed transcripts still have costs. Unvisited projects do not load document recovery or start work. Browser source buffers belong only to its selected project; inactive project views retain small cursor/prompt records. Directory metadata is capped at 12 cached directories / 8,000 entries, with 64 expanded folders and paged rendering (at most 1,024 leaf entries at the largest expansion count, plus headers and controls).

| Measured browser asset (`cc68e787…`) | Source bytes | Gzip estimate |
| --- | ---: | ---: |
| `index.html` | 19,893 | 5,141 |
| `app.js` | 108,034 | 26,062 |
| `style.css` | 41,080 | 7,941 |
| Total | 169,007 | 39,144 |

Gzip remains an offline estimate; assets are served without response compression. The project picker added 9,894 uncompressed asset bytes over the preceding combined-tree release; PC-entry recovery added a further 6,425. Explicit current-project controls and input guards add 4,842 more bytes. The shared switcher uses existing bounded project metadata and starts no work. Only attached roots are selectable; expanding a folder only browses its files. Browser-held terminal input uses the existing 32 project-view records, with at most 8,192 characters per retained draft; empty drafts retain no string. Native terminal typing still streams to the PTY. The PC opener runs only on startup when requested or during an explicit recovery action; its original-tab polling ends after successful authentication or an eight-second window. The revision adds no runtime library, font, image asset, database, CDN, editor framework or resident service. [Raw multi-project result](tests/multi-project.json) records the exact build, checks and measurements. The shared switcher's and welcome page's browser heap and total browser RAM have not been measured separately.

## Selected-project file tree revision — October 10, 2026

Release `9154cb383ba221600bfe89f2b67b5da57352fcf109e24192bf7c5273e245936b` renders only the current project's root and cached folder entries in Files. The project picker continues to use the existing shared root registry. Filtering and pagination consider only the selected tree, so inactive cached directories produce no Files nodes or filter results. Existing cache and project limits are unchanged; this adds no retained state, framework, background process, scan or polling.

The stripped executable is still **2,907,184 bytes**. Browser source totals **169,079 bytes**, 72 more than `cc68e787…`; `app.js` is 108,106 bytes (26,077 gzip), while HTML and CSS are unchanged. The three-asset offline gzip estimate is 39,159 bytes. This change has functional browser checks but no new RAM benchmark. The preceding RSS measurements and raw multi-project result describe `cc68e787…`; they must not be attributed to the new release. Rendering fewer project entries is not a measured numerical RAM saving or a near-zero-memory guarantee.

## Folder heading simplification — October 10, 2026

Release `cc9acb0d631b1d59afef806fc655990fcda6fdbcaccc5b85d970d9393162efc0` replaces the root's separate expand and select buttons with one disclosure button and removes its redundant Current badge. The persistent project switcher retains the selected-project indication. The root uses two fewer DOM nodes and no additional state, event listeners, timers, scans, processes or runtime dependencies. Existing cache and project limits remain.

The stripped executable is **2,907,184 bytes**. Browser source totals **168,285 bytes**, 794 fewer than `9154cb38…`; the three-asset offline gzip estimate is 39,058 bytes. `app.js` is 107,454 bytes and `style.css` is 40,938 bytes; HTML is unchanged. No RAM benchmark was run for this layout change, so no numerical RAM saving is claimed. Historical memory measurements retain their original build identities.

## Files menu simplification — October 10, 2026

Release `2e8265e457215f1570ae99a1e1da011764ab7672cd7cec5ed3e73de0e1e72dea` removes the Files action row and Open tab, reuses the project picker for project actions, and shows existing retained-document controls within Files. On short phone viewports, those controls are hidden to reserve room for navigation. No new retained state, scan, polling, runtime dependency or process is added. Four static DOM nodes are removed overall; the retained-document rows already existed and remain bounded by existing limits.

The stripped executable remains **2,907,184 bytes**. Browser source totals **166,632 bytes**, 1,653 fewer than `cc9acb0d…`; the offline gzip estimate is 38,846 bytes. HTML/JavaScript/CSS are 19,683 / 107,160 / 39,789 bytes respectively. No RAM benchmark was run for this UI change, so these source sizes and DOM counts do not establish a numerical RAM saving.

## AI Split and Tab layouts — October 10, 2026

Release `2dd15ad88a81476f2b803945a788486f4ad2cbe51226d0d0e850858bae1d3363` uses the existing single editor, prompt and conversation DOM for both layouts. Layout switching starts no shell or provider job. Two session-storage values remember the desktop and phone layout choices. The existing bounded project-view records gain an AI-open flag, and bounded document records retain their last applied cursor/scroll position separately from the requested position so layout clamping does not overwrite it. No source buffer or transcript is duplicated. No runtime dependency, scan, polling or background process is added.

The stripped executable remains **2,907,184 bytes**. HTML/JavaScript/CSS are **20,346 / 111,940 / 44,728 bytes**, totaling **177,014 bytes**: 10,382 more than the preceding `2e8265e…` release. The offline three-asset gzip estimate is **40,730 bytes**, 1,884 more; HTTP responses remain uncompressed. These are artifact sizes. No new host RAM, browser RAM or retained-heap benchmark was run, and the historical RSS figures above retain their original build identities.

## Workspace composition redesign — October 11, 2026

Release `e089dc02d8dbc02b8d6252bb980a84a3459ec6cba013bda85dd8a01bfd605c62` changes the existing three browser assets: a single desktop command row, neutral editor/chat surfaces, a bounded reading column and composer controls. Split and Tab reuse the same editor and transcript. The empty conversation has three fixed suggestion actions that fill the native prompt without starting a provider. Project selection remains in the persistent header, with parent context for matching root names. No runtime dependency, external font, image, scan, polling, background service or duplicate source/conversation is added. Existing session and cache bounds remain.

| Browser asset | Source bytes | Offline gzip estimate |
| --- | ---: | ---: |
| `index.html` | 20,584 | 5,355 |
| `app.js` | 113,188 | 27,371 |
| `style.css` | 44,935 | 8,435 |
| Total | 178,707 | 41,161 |

The stripped executable is **2,907,184 bytes**. Browser source is 1,693 bytes larger than `2dd15ad8…`; the offline gzip estimate grows by 431 bytes. HTTP responses remain uncompressed. These artifact measurements do not establish a RAM increase or saving. No host RSS, total browser RAM or controlled retained-heap benchmark was run for this redesign. Browser workflow reports retain incidental post-work JavaScript heap readings with their build identity; these exclude native browser memory and are not a memory budget or peak. Historical RSS figures above retain their original release identities.

## Pairing entry recovery — October 11, 2026

Release `d9fab71400da1e3a60e826887d81af69c7035b771367a4b123ac61b5baca95ac` adds complete-link recovery, clipboard fallback and a direct device-list shortcut. The existing status span becomes the online button, reusing the existing bounded client metadata and device list. A single small pending-invitation record in origin-scoped tab session storage survives refresh until observed expiry or authentication; it contains no document buffer or session credential. There is no added runtime dependency, process, polling or provider work. Existing document/history/cache and connection limits remain.

The stripped executable is **2,923,712 bytes**. HTML/JS/CSS total **184,850 bytes**, with a **42,483-byte offline gzip estimate**. This adds 5,366 source bytes and 1,058 offline gzip bytes over the measured `82cd8870…` release; HTTP responses remain uncompressed. Functional and security checks pass on this new build, but no new RAM benchmark was run. The 12.8% retained-JS and host measurements at the top remain attributed to the measured `82cd8870…` binary. Artifact sizes and a bounded invitation record do not establish total RAM costs.

## Native macOS desktop — October 11, 2026

The first app contains the existing embedded Rust host and a small AppKit/WKWebView window. It uses the system WebKit and Swift frameworks, without a bundled Chromium, Electron, Node runtime, editor framework or dependency addition. The normal app starts no compiler or source watcher. Desktop ownership adds one parent-pipe reader thread to the host; closing that pipe uses its existing graceful shutdown. The custom editor, terminal, AI and project bounds continue to apply.

Development watches this checkout's three UI assets, Rust source files and Cargo manifests every 600 ms, only in the dev window. It does not scan attached user projects. CSS changes reuse the current document and host; JS/HTML changes reuse acknowledged host buffers and a capped 256 KiB tab view record, with no second source buffer or chat transcript. Rust compilation runs on source changes and ends after each build. Native and browser draft checks defer disruptive reloads. These development costs do not run in the regular app.

The initial native executable is about **0.24 MB** and the signed embedded host about **3.04 MB**; exact sizes and validation are in `tests/desktop/production-bundle.json`. This is a roughly **3.3 MB binary payload**, not a total-RAM measurement. WKWebView still uses web-content and networking processes. No controlled total-RSS comparison against Electron or Cursor was run, and the large-file native-textarea limit documented above remains. Native reload/security checks use disposable files and fake providers; no inference is sent.

## Floating AI surfaces — October 11, 2026

AI and Terminal now share the same background, border, corner radius and static shadow on desktop and phones. Split leaves a visible gutter; desktop Tab bounds the AI surface to 900 pixels. A smaller empty-state title and one-line-height prompt keep the interface compact. This is a CSS change using the existing editor, transcript, terminal and DOM; it adds no runtime library, image, font, duplicate buffer or transcript, blur filter or animation. Current Chromium/WebKit UI reports and the floating-surface workspace review verify the existing state-preservation and region bounds. No new RAM benchmark was run for the visual treatment.

`make dev-open` uses macOS LaunchServices for an independent app launch and returns immediately. Its private log receives dev compiler output; the native watcher and owned Rust host are unchanged. The foreground `make dev` workflow remains available. The launcher validation uses a disposable app identifier, workspace and fake providers and verifies CSS hot reload after the caller exits.
