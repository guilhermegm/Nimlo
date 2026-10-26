# Toolbar review

Build four compact commands: Projects with the selected root, Files with the open
filename, Session with its live connection count, and AI with its own options.
Compare actual screenshots against the previous toolbar at the same viewports.
Keep the existing floating surfaces and quiet styling. Each dropdown must have
one clear purpose, fit a 320px phone, and work with keyboard navigation. Preserve
the same editor, AI conversation and host terminal throughout.

The builder implements small changes; a separate critic reviews the actual
screenshots and behavior. Fix the largest gap and repeat until the critic accepts
the result. Record evidence here as the review progresses.

## Evidence

- Baseline: `616e2b5`, captured from its frozen release executable in
  `tests/workspace-ui-review-toolbar-before-chromium/` using disposable projects,
  fake AI providers and a real disposable host shell.
- Round 1: actual screenshots beat the baseline for grouping and phone use.
  Both Chromium and WebKit passed 33 UI checks; the workspace review passed
  23 checks after correcting its old toolbar navigation helper.
- Critic rejected inconsistent arrow navigation in Projects and identified
  focused device buttons being replaced during live updates. Round 2 gives
  all four popups the same keyboard navigation, preserves device-button focus,
  and renders device rows only while Session is open. A separate keyboard check
  also caught asynchronous command-search refresh hiding a recoverable error;
  errors now clear on user changes rather than a late search result.
- Final visual rounds moved phone Save beside the dock to preserve filename
  space, kept the filename extension visible, and exposed the full filename
  inside Files. The blind visual reviewer preferred the candidate in all three
  initial comparisons, rejected its dirty-phone filename, then accepted the
  revised candidate. See `tests/toolbar-visual-review.json`.
- The keyboard error also had a native dialog lifecycle race: a delayed close
  event could clear a newly reopened command input. The close callback now
  checks whether the dialog has reopened, and each opening resets old search
  state. Both keyboard engines verify rejected commands remain intact.
- Final build `2d76da7cf277`: independent critic accepted; 23 workspace checks,
  33 UI checks per engine, and 16 keyboard checks per engine passed (121 checks).
  Repeated layout switches retained 582 DOM nodes before and after 15 cycles.
  AI approval/Markdown checks passed (19) and the shared browser workflow passed.
  Both signed desktop app bundles were rebuilt and signature verification passed.
- Final artifacts: `tests/workspace-ui-review-toolbar-final-labels-chromium/`,
  `tests/toolbar-critic.json`, `tests/ui.json`, `tests/ui-webkit.json`, and the
  keyboard reports. Tests use disposable roots, fake providers and fixture
  shells. Physical mobile devices and real inference were not tested.
- Live browser preview was audited idle across all three roots. Its active
  internet connector was preserved; it was not restarted for this UI change.
