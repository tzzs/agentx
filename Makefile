SHELL := /bin/sh
NPM ?= npm
CLI := node dist/src/cli.js

.DEFAULT_GOAL := help

.PHONY: help install build test check ci pack install-local link unlink \
	claude codex proxy doctor version clean

help: ## Show available targets
	@printf '%s\n' 'Usage: make <target>' '' 'Targets:'
	@awk 'BEGIN { FS = ":.*##" } /^[a-zA-Z0-9_-]+:.*##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install exact dependencies from package-lock.json
	$(NPM) ci

build: ## Compile TypeScript into dist/
	$(NPM) run build

test: ## Build and run the test suite
	$(NPM) test

check: test ## Run tests and verify the npm package contents
	$(NPM) pack --dry-run

ci: install test ## Reproduce the GitHub Actions verification locally

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
