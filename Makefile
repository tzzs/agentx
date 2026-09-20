SHELL := /bin/sh
NPM ?= npm
CLI := node dist/src/cli.js

.DEFAULT_GOAL := help

.PHONY: help install build test test-one lint typecheck check ci pack install-local link unlink \
	claude codex proxy doctor version clean

help: ## Show available targets
	@printf '%s\n' 'Usage: make <target>' '' 'Targets:'
	@awk 'BEGIN { FS = ":.*##" } /^[a-zA-Z0-9_-]+:.*##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install exact dependencies from package-lock.json
	$(NPM) ci

# npm ci/install stamps node_modules/.package-lock.json; using it as a
# prerequisite makes `make build`/`make test` auto-install deps only when
# missing or stale, instead of failing with "tsc: not found".
node_modules/.package-lock.json: package-lock.json
	$(NPM) ci

build: node_modules/.package-lock.json ## Compile TypeScript into dist/
	$(NPM) run build

test: node_modules/.package-lock.json ## Build and run the test suite
	$(NPM) test

# make test-one F=test/streaming — a single test file, quoted so a bare
# `make test-one` doesn't expand to every file in the directory.
test-one: node_modules/.package-lock.json ## Build and run one test file (F=test/<name>)
	$(NPM) run test:one -- "dist/$(F).test.js"

lint: node_modules/.package-lock.json ## Lint the repository
	$(NPM) run lint

typecheck: node_modules/.package-lock.json ## Type-check src/ and test/ without emitting
	$(NPM) run typecheck

check: test lint ## Run tests, lint and verify the npm package contents
	$(NPM) pack --dry-run

ci: install lint test ## Reproduce the GitHub Actions verification locally

pack: build ## Build and create an npm tarball
	$(NPM) pack

install-local: build ## Install the current package tarball globally
	package=$$($(NPM) pack --silent); $(NPM) install --global "./$$package"; rm -f "$$package"

link: build ## Create a global symlink to the local CLI
	$(NPM) link

unlink: ## Remove the global agentx symlink
	$(NPM) unlink --global agentx

claude: build ## Start Claude Code through the local adapter
	$(CLI) claude

codex: build ## Start Codex through the local adapter
	$(CLI) codex

proxy: build ## Start only the local adapter
	$(CLI) proxy

doctor: build ## Inspect the local environment
	$(CLI) doctor

version: build ## Print the CLI version
	$(CLI) version

clean: ## Remove build output and local npm tarballs
	rm -rf dist *.tgz
