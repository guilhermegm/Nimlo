# Interface gauntlet

## Brief

Build a compact, simple editor mock for a custom low-memory editor with integrated AI and one live session across devices. The user selected Zed's compact panels and quiet styling as the comparison reference.

## Working prompt

Build a compact, simple interface mock for a custom low-memory code editor with Codex and Claude integration and one session across PC and phone.

The bar is the actual Zed editor shown on https://zed.dev/ai. Obtain its published editor screenshot and compare against it directly. Judge usable code space, legible text, quiet controls, and how quickly someone can find the AI conversation and session controls. Record the mock's actual source size, external runtime requests, and browser measurements; never substitute those for total production RAM.

Break the work into desktop editing, AI and session interactions, and the phone layout. Use a builder and a separate harsh critic with fresh context. Show anonymized A/B captures at comparable scale. The critic chooses the stronger interface for this brief and names the biggest remaining gap. Send failures back to the builder.

Keep this progress file current. Keep looping until the critic picks ours. Run builders and critics as separate subagents.

## Reference provenance

- Page: https://zed.dev/ai
- Published screenshot: https://zed.dev/img/agentic/posters/explore-poster.webp
- Local reference: `review/zed-explore.webp`
- Additional empty-session reference: https://zed.dev/img/post/claude-code-zed/video-poster.webp
- References are review material only; the mock does not load them.

## Acceptance criteria

- Code is the largest desktop workspace surface; supporting panels are compact and collapsible.
- AI provider, proposed changes, and session/device state are discoverable without a large dashboard.
- Phone layouts use one main surface at a time with touch-friendly navigation.
- Visible controls demonstrate meaningful local interactions; simulated AI and device status are labeled.
- No framework, packaged editor, external font, image dependency, perpetual animation, or background polling in the mock.
- No invented RAM figures, live provider connections, or actual cross-device claims.
- Browser inspection covers desktop, narrow screens, console errors, and representative interactions.

## Progress

1. Saved the product and architecture plan to `../PLAN.md`.
2. User selected Zed as the visual reference; acquired and inspected the published screenshots.
3. Built a self-contained HTML mock using the builder's layout recommendations. The lead agent implemented the file; a separate critic inspected actual captures without implementation context.
4. First critique selected B (this mock) over A (the published Zed screenshot) for this brief. Phone rejected: long code and diff lines had no sufficiently visible horizontal-navigation affordance.
5. Revised the phone editor with an explicit horizontal code slider and Start/End indication. Wrapped review diffs on phones and increased the remaining primary touch targets to 44 pixels.
6. Second critique again selected B and accepted the phone layout, with no remaining screenshot-visible blocking gap.

## Initial version verification

- Chrome 155.0.8059.39, desktop capture 1440 × 960 and phone emulation 390 × 844.
- Source: **31,034 bytes**; gzip representation: **9,660 bytes**.
- The interface loaded one local HTML request and made **zero external runtime requests**. No runtime package dependencies.
- Initial DOM: **259 elements**. One desktop JavaScript heap observation: **1,578,780 bytes used**. This is neither full browser memory nor production editor memory, and it is not a long-session benchmark.
- **19 browser checks passed**: file selection, explicit local save/reload, provider-driven simulated replies, bounded transcript retention, applying a proposal to its target, simulated control transfer and return, Escape dismissal, both panel toggles, rejection of conflicting proposals while preserving edits, phone navigation, horizontal code access, layout overflow, and script errors.
- No page-wide overflow at 320, 390, 760, 768, 1024, 1440, and 1920 pixel widths. The code area deliberately scrolls horizontally.
- Recorded results: `review/metrics.json` and `review/checks.json`.
- Captures: `desktop.png`, `mobile.png`, `mobile-ai.png`, `mobile-review.png`, `session.png`, and `review-conflict.png`.

## Critique method and limits

Desktop captures used neutral A/B filenames, matching widths, and cropped top branding. The reference is a published Zed snapshot, not a controlled feature-parity or performance benchmark. Familiar interfaces can remain recognizable; this is an independent design critique, not a formal blinded study. Phone captures were judged against the phone acceptance criteria because the reference is a desktop interface.

The critic's final result was: “Desktop: B” and “Phone: accept,” with no remaining visible blocking gap. This applies only to the interface mock. Browser emulation does not validate real iOS/Android keyboard composition, production accessibility, remote synchronization, or subscription authentication.

## Scope

This is an interface prototype. Production editor internals, provider authentication, host service, secure remote access, and real device synchronization remain planned work.


## Simplicity revision

The user asked for fewer visible details after reviewing the first mock. This preference supersedes the earlier preference for visible supporting panels.

- Default to the current file and code under one small toolbar. Files and session details use popovers; the AI panel opens only on request.
- Remove permanent sidebars, duplicate file tabs/breadcrumbs, thread headings, timestamps, avatars, completed activity rows, both bottom status bands, and phone bottom navigation.
- Keep Save hidden until there is an edit. Retain explicit long-line access and a complete wrapping diff on phones.
- Independent critic accepted the reduced desktop/phone layout and requested a short “2 devices” label for session discoverability. Added that label while keeping ownership and handoff details in the popover.
- Narrow-screen inspection caught overflow when Save appeared at 320px. Constrained the main grid and allowed the filename to truncate while preserving action labels.

Source after the first simplification: **23,776 bytes**, **7,972 bytes gzipped**, down from 31,034 bytes. Initial DOM at that stage had **167 elements**, down from 259. There are still no external runtime requests or runtime package dependencies. These are source/DOM reductions, not a measured total RAM reduction. Current measurements and interaction checks live in `review/metrics.json` and `review/checks.json`.

Earlier screenshots are preserved as `review/previous-desktop.png` and `review/previous-mobile.png`; the primary screenshots now show the simplified design.

Final independent review: **Accept.** The session control is discoverable and no screenshot-visible blocking gaps remain. Nineteen current browser checks pass, including the 320px dirty-file header.


## Further compactness pass

The user requested another reduction in visible information while keeping a nice, consistent UI. A fresh builder and a separate harsh critic are working from actual captures and the existing Zed reference.

Working bar: the revised interface must win against the previous mock for simplicity and consistency, preserve easy access to AI and shared-session controls, and keep full code readable on phones. Compare actual desktop and phone captures at equal viewports. Iterate on the critic’s single biggest remaining gap until it accepts the revised result. Keep zero external runtime dependencies and verify the interactions affected by the redesign.

Baseline captures: `review/compact-before-desktop.png` and `review/compact-before-mobile.png`. Status: completed; independent critic accepted the revised desktop and phone layouts.


### Final result of this pass

- Default toolbar has only the filename/workspace control and Ask AI. Save appears only for unsaved changes. Files, devices, and handoff share one menu. Demo labels appear in the relevant menu and AI surface.
- Unified charcoal colors, muted syntax colors, spacing, fonts, borders, and control styles. Desktop toolbar is 36px; phone toolbar is 44px with 44px touch targets.
- Phone code soft-wraps at 16px; removed its gutter and bottom scroll-control bar. Complete long tokens remain accessible. Native input and syntax highlighting use matching widths, padding, and font metrics. The builder compared all 660 highlighted characters with a plain-text mirror: no vertical offset and at most 0.047px horizontal offset.
- Independent critic selected **1** over **2** for both desktop and phone in the neutral capture pairs, and **accepted** the new interface. It also inspected the workspace menu and phone AI view. No screenshot-visible blocking gap remains. The optional next refinement is indentation on wrapped continuation lines.
- Final touch-target verification caught a 40px-wide close button in the phone review dialog. Expanded it to 44px and reran the affected checks successfully.

Final source: **21,641 bytes**, **7,474 bytes gzipped**; **159 DOM elements** initially. One local HTML request, zero external runtime requests, zero runtime package dependencies, and no script errors. **28 browser checks passed**, including save/reload, file switching, proposal application and conflict preservation, device handoff, narrow layout overflow, wrapping, overlay style alignment, and mobile touch targets. Source size and heap snapshots do not measure total browser RAM.

Latest captures: `desktop.png`, `mobile.png`, `desktop-ai.png`, `mobile-ai.png`, `mobile-review.png`, `session.png`, and `review-conflict.png`. Neutral comparison captures: `review/compact-choice-1.png`, `review/compact-choice-2.png`, `review/compact-phone-choice-1.png`, and `review/compact-phone-choice-2.png`. The neutral filenames reduce labeling cues; the reference and earlier UI can still be recognizable, so this is not a formal blinded study.


## Terminal mock addition

The terminal design had been saved only to the plan. After the user asked where it was in the mock, implemented a hidden-by-default terminal demo reachable from the filename/workspace menu or Ctrl + backtick. The default toolbar retains its two actions. Desktop uses a compact bottom dock; phones use one full terminal surface. The same palette, borders, typography, and control styles carry through. Opened surfaces show “PC host · Demo” and sample command output identifies its simulation.

The browser demo supports sample commands, clear, bounded command history, Ctrl+C/Stop, and a simulated continuing process. Hiding it preserves its transcript and running state. Device handoff blocks terminal input and controls while retaining pending input. Output is rendered as text, and its retained transcript is limited to 100 rows / 16,384 characters. This is a UI demo, not a shell connection or a complete terminal emulator.

A fresh independent critic inspected actual baseline/reference and terminal captures, then accepted **desktop**, **phone**, and **menu**. No blocking visual gap remained. The comparison judged consistency with the prior compact mock and quiet Zed reference; it was not a blinded performance study.

Verification: **46 checks passed** (21 existing interactions/layout checks and 25 terminal checks), with no script errors or page-wide overflow from 320px through 1920px. The new checks cover lazy initialization, menu/shortcut access, dock/full-surface layouts, demo commands, persistent hidden state, interrupt, command recall, handoff/input preservation, literal output escaping, bounded output, phone touch targets, and AI/file navigation. Evidence: `review/checks.json` and `review/terminal-checks.json`.

Latest source: **28,900 bytes**, **9,161 bytes gzipped**, **181 initial DOM elements**. Zero external runtime requests and no package dependencies. These figures do not establish real host-terminal or total browser memory use. Captures: `desktop-terminal.png`, `mobile-terminal.png`, `terminal-menu.png`; standard code/AI screenshots refreshed.
