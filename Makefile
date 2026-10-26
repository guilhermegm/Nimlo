.DEFAULT_GOAL := help
SHELL := /bin/sh
.NOTPARALLEL:
.PHONY: help build build-host run dev dev-open install deploy open web package check test test-host test-native test-web test-keyboard test-updates test-update-core verify clean
PROJECT ?=
STATE_DIR ?=
INSTALL_DIR ?= $(HOME)/Applications
BROWSER ?= chromium
LISTEN ?= 127.0.0.1:8875
export PROJECT STATE_DIR INSTALL_DIR BROWSER LISTEN
help:
	@printf '%s\n' 'Nimlo — native Neovim editor' '' 'make build       Build target/desktop/Nimlo.app' 'make run         Build and open the native app' 'make install     Install Nimlo in Applications' 'make open        Open the installed app' 'make web         Run the browser/phone companion host' 'make package     Create a release ZIP' 'make test        Host tests' 'make test-native Native Neovim, shared editing and companion checks' 'make test-updates Persistent update notices and GitHub release checks' 'make test-web    Existing browser workflow checks' 'make verify      Static checks + host + native tests' '' 'Options: PROJECT="/path/to/project" STATE_DIR="/isolated/state" BROWSER=webkit'
build:
	./scripts/build-desktop.sh
build-host:
	cargo build --release
run: build
	@set --; if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; if [ -n "$${STATE_DIR}" ]; then set -- "$$@" --state-dir "$${STATE_DIR}"; fi; exec "./target/desktop/Nimlo.app/Contents/MacOS/Nimlo" "$$@"
dev: run
dev-open: run
install: build
	./scripts/install-desktop.sh
deploy: install
open:
	open "$${INSTALL_DIR}/Nimlo.app"
web: build-host
	@set -- --resume-project --listen "$${LISTEN}" --state-dir "$${STATE_DIR:-$$HOME/.nimlo-neovim/web}"; if [ -n "$${PROJECT}" ]; then set -- "$$@" --workspace "$${PROJECT}"; fi; exec ./target/release/nimlo-editor --open-browser "$$@"
package: build
	./scripts/package-desktop.sh
check:
	cargo fmt --check
	cargo clippy --release --all-targets -- -D warnings
	@for f in web/*.js scripts/*.cjs; do node --check "$$f" || exit; done
	@for f in scripts/*.sh; do sh -n "$$f" || exit; done
	python3 -m py_compile scripts/fetch-neovim.py
test: test-host
test-host:
	cargo test --release -- --test-threads=1
test-native: build
	target/desktop/Nimlo.app/Contents/Resources/neovim/bin/nvim --headless -u NONE -i NONE --noplugin -l scripts/neovim-runtime-check.lua
	node scripts/neovim-native-check.cjs
test-update-core:
	@mkdir -p target/update-tests
	swiftc -O desktop/neovim/Updates.swift scripts/update-check.swift -o target/update-tests/updates-check
	target/update-tests/updates-check
test-updates: build test-update-core
	node scripts/update-notice-check.cjs
test-web: build-host
	@mkdir -p tests
	NIMLO_BROWSER="$${BROWSER}" node scripts/setup-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/lazy-files-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/keyboard-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/ai-chat-review.cjs
test-keyboard: build-host
	NIMLO_BROWSER="$${BROWSER}" node scripts/keyboard-check.cjs
	NIMLO_BROWSER="$${BROWSER}" node scripts/file-navigation-check.cjs
verify: check test-host test-native test-updates
clean:
	cargo clean
