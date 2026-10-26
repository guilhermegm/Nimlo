.DEFAULT_GOAL := help
SHELL := /bin/sh

# The release host and screenshot/report outputs are shared. Keep workflows
# serial even with make -j so builds and fixture suites cannot race each other.
.NOTPARALLEL:
.PHONY: help dev dev-open run web build build-host build-dev open install deploy package \
        icons fmt check test test-host verify test-desktop test-web test-ui test-keyboard \
        test-ai test-editor-input test-find-in-file test-lazy-files test-updates test-update-live test-security test-pairing test-session-access test-internet test-internet-live \
        test-performance test-performance-core test-performance-browser performance-baseline performance-plan clean

PROJECT ?=
PORT ?=
STATE_DIR ?=
LISTEN ?= 127.0.0.1:7410
ORIGIN ?=
INSTALL_DIR ?= $(HOME)/Applications
BROWSER ?= chromium
TEST_THREADS ?= 1
NIMLO_BINARY ?= target/release/nimlo-editor
PERFORMANCE_BASELINE_REF ?= a811aaf

# Pass paths through the environment, rather than interpolating user values
# into shell source. Spaces, quotes and backticks remain literal path text.
export PROJECT PORT STATE_DIR LISTEN ORIGIN INSTALL_DIR BROWSER TEST_THREADS NIMLO_BINARY PERFORMANCE_BASELINE_REF

help:
	@printf '%s\n' \
	  'Nimlo — development and local macOS deployment' \
	  '' \
	  '  make dev                 Native desktop with hot reload' \
	  '  make dev-open            Open hot-reload app and return immediately' \
	  '  make run                 Build and run the regular desktop app' \
	  '  make web                 Build and run the browser host (port 7410)' \
	  '  make build               Build target/desktop/Nimlo.app' \
	  '  make build-dev           Build target/desktop/Nimlo Dev.app' \
	  '  make icons               Rebuild desktop and web icons from the logo' \
	  '  make build-host          Build only the release Rust host' \
	  '  make deploy / install    Build and install in ~/Applications' \
	  '  make open                Open the installed app' \
	  '  make package             Build a release ZIP in target/packages/' \
	  '' \
	  '  make fmt                 Format Rust source' \
	  '  make check               Format, strict Clippy, JS and shell checks' \
	  '  make test                Rust host tests (release profile, serial fixtures)' \
	  '  make verify              Check + host, native, browser and security suites' \
	  '  make test-desktop        Native reload, bundle and dev security checks' \
	  '  make test-web            Shared-session, UI, sign-in and setup checks' \
	  '  make test-ui             Desktop/phone UI checks' \
	  '  make test-keyboard       File commands and Vim navigation' \
	  '  make test-editor-input   Typing, indentation, brackets and caret behavior' \
	  '  make test-find-in-file   In-file search, navigation and bounded-file checks' \
	  '  make test-lazy-files     Saved-file history, closing and draft recovery' \
	  '  make test-updates        Signed feed, transport, restart and release checks' \
	  '  make test-update-live    Verify the public Firebase update download' \
	  '  make test-ai             Fake-provider chat and approval checks' \
	  '  make test-security       Auth, filesystem and pairing boundaries' \
	  '  make test-pairing        Pairing and invitation entry checks' \
	  '  make test-session-access  Device permissions and pairing password checks' \
	  '  make test-internet       Isolated fake tunnel checks' \
	  '  make test-internet-live  Real temporary public tunnel check' \
	  '  make test-performance    Native release gate against a frozen reference' \
	  '  make test-performance-core  Draft, patch, editor and gate correctness checks' \
	  '  make performance-plan    Preview native measurement workflow' \
	  '  make performance-baseline  Prepare immutable reference app and diagnostics' \
	  '  make test-performance-browser  Earlier browser workload measurements' \
	  '  make clean               Remove generated artifacts under target/' \
	  '' \
	  'Options: PROJECT="/path/to/project" PORT=8743 STATE_DIR="/path/to/state"' \
	  '         INSTALL_DIR="/path/to/Applications" BROWSER=webkit TEST_THREADS=1' \
	  'Web:     LISTEN=127.0.0.1:7410 ORIGIN=https://your-tunnel-host' \
	  'Tests:   Node + the documented Playwright/ws development tools are required.'

dev:
	@set --; \
	if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; \
	if [ -n "$${PORT}" ]; then set -- "$$@" --port "$${PORT}"; fi; \
	if [ -n "$${STATE_DIR}" ]; then set -- "$$@" --state-dir "$${STATE_DIR}"; fi; \
	exec ./scripts/dev.sh "$$@"

dev-open:
	@set --; \
	if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; \
	if [ -n "$${PORT}" ]; then set -- "$$@" --port "$${PORT}"; fi; \
	if [ -n "$${STATE_DIR}" ]; then set -- "$$@" --state-dir "$${STATE_DIR}"; fi; \
	exec ./scripts/dev-open.sh "$$@"

run:
	@set --; \
	if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; \
	if [ -n "$${PORT}" ]; then set -- "$$@" --port "$${PORT}"; fi; \
	if [ -n "$${STATE_DIR}" ]; then set -- "$$@" --state-dir "$${STATE_DIR}"; fi; \
	exec ./scripts/desktop.sh "$$@"

web: build-host
	@nimlo_state_root="$${HOME}/.nimlo"; \
	if [ ! -e "$$nimlo_state_root" ] && [ -d "$${HOME}/.relay-editor" ]; then nimlo_state_root="$${HOME}/.relay-editor"; fi; \
	set -- --resume-project --listen "$${LISTEN}" --state-dir "$${STATE_DIR:-$$nimlo_state_root/web}"; \
	if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; \
	if [ -n "$${ORIGIN}" ]; then set -- "$$@" --origin "$${ORIGIN}"; fi; \
	exec ./scripts/run.sh "$$@"

icons:
	sh ./scripts/build-icons.sh

build:
	./scripts/build-desktop.sh

build-dev:
	./scripts/build-desktop.sh dev

build-host:
	cargo build --release

install: build
	./scripts/install-desktop.sh

deploy: install

open:
	@test -d "$${INSTALL_DIR}/Nimlo.app" || { printf '%s\n' 'Run make deploy first, using the same INSTALL_DIR.' >&2; exit 1; }
	open "$${INSTALL_DIR}/Nimlo.app"

package: build
	./scripts/package-desktop.sh

fmt:
	cargo fmt

check:
	cargo fmt --check
	cargo clippy --release --all-targets -- -D warnings
	@for nimlo_file in web/*.js scripts/*.cjs; do node --check "$$nimlo_file" || exit; done
	@for nimlo_file in scripts/*.sh; do sh -n "$$nimlo_file" || exit; done

test: test-host

test-host:
	cargo test --release -- --test-threads="$${TEST_THREADS}"

verify: check test-host test-desktop test-web test-security test-session-access

test-desktop: build build-dev
	swiftc desktop/macos/Policy.swift desktop/macos/PolicyCheck.swift -o target/desktop/policy-check
	target/desktop/policy-check
	node scripts/desktop-welcome-check.cjs
	node scripts/dev-check.cjs
	node scripts/desktop-check.cjs
	node scripts/desktop-production-check.cjs
	node scripts/native-find-check.cjs
	node scripts/native-download-check.cjs

test-web: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/browser-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/ui-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/signin-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/setup-check.cjs

test-ui: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/ui-check.cjs

test-keyboard: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/keyboard-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/file-navigation-check.cjs

test-editor-input: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/editor-input-check.cjs

test-find-in-file: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/find-in-file-check.cjs

test-lazy-files: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/lazy-files-check.cjs

test-updates: build
	@mkdir -p target/updater-review
	swiftc -O desktop/macos/UpdateManifest.swift scripts/update-manifest-check.swift -o target/updater-review/manifest-check
	target/updater-review/manifest-check --report target/updater-review/manifest-transport.json
	swiftc -O desktop/macos/UpdateManifest.swift desktop/macos/Updater.swift scripts/update-controller-check.swift -o target/updater-review/controller-check -framework AppKit
	target/updater-review/controller-check --report target/updater-review/controller.json
	@mkdir -p target/update-export-review
	swiftc -O desktop/macos/UpdateManifest.swift desktop/macos/Updater.swift scripts/update-export-check.swift -o target/update-export-review/export-check -framework AppKit -framework CryptoKit
	target/update-export-review/export-check --report target/update-export-review/report.json
	node scripts/update-handoff-check.cjs
	node scripts/update-installer-check.cjs
	node scripts/installed-update-check.cjs
	node scripts/update-release-check.cjs
	node scripts/deploy-updates-check.cjs
	node scripts/update-hosting-inventory-check.cjs

test-update-live:
	@mkdir -p target/updater-review
	swiftc -O desktop/macos/UpdateManifest.swift desktop/macos/Updater.swift scripts/update-live-check.swift -o target/updater-review/live-check -framework AppKit
	target/updater-review/live-check --feed https://nimlo-editor-updates.web.app/stable/latest.json --public-key desktop/macos/UpdatePublicKey.txt --report target/updater-review/live-firebase.json

test-ai: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/ai-chat-review.cjs

test-security: build-host
	node scripts/security-check.cjs
	node scripts/pairing-check.cjs

test-pairing: build-host
	node scripts/pairing-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/pairing-entry-check.cjs

test-session-access: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/session-access-check.cjs
	node scripts/session-permissions-ui-check.cjs

test-internet: build-host
	node scripts/internet-check.cjs

test-internet-live: build-host
	node scripts/internet-live-check.cjs

test-performance-core: build-host
	node scripts/performance-editor-check.cjs
	node scripts/draft-retention-check.cjs
	node scripts/patch-check.cjs
	NIMLO_BROWSER=chromium node scripts/editor-window-check.cjs
	NIMLO_BROWSER=webkit node scripts/editor-window-check.cjs
	node scripts/native-performance-gate-selfcheck.cjs

performance-plan:
	node scripts/native-performance-run.cjs --baseline-ref "$${PERFORMANCE_BASELINE_REF}" --app target/desktop/Nimlo.app --plan 1

performance-baseline:
	node scripts/native-performance-prepare-baseline.cjs --source-ref "$${PERFORMANCE_BASELINE_REF}"

test-performance: build test-performance-core
	caffeinate -d -i node scripts/native-performance-run.cjs --baseline-ref "$${PERFORMANCE_BASELINE_REF}" --app target/desktop/Nimlo.app

test-performance-browser: build-host
	node scripts/performance-editor-check.cjs
	node scripts/performance-check.cjs

clean:
	cargo clean
