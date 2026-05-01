SHELL := /bin/sh

GIT_REMOTE ?= origin
VERSION ?=
PUBLISH_ACCESS ?= public
PUBLISH_TAG ?= latest
GITHUB_RELEASE ?= 1

.PHONY: help test pack publish

help:
	@printf "%s\n" \
		"Targets:" \
		"  make test                 Run the test suite." \
		"  make pack                 Preview the npm package contents." \
		"  make publish              Release to npm and GitHub." \
		"" \
		"Publish options:" \
		"  VERSION=patch             Optional release type or exact version; skips prompt." \
		"  PUBLISH_ACCESS=public     npm package access level." \
		"  PUBLISH_TAG=latest        npm dist-tag to publish." \
		"  GIT_REMOTE=origin         Git remote used for pushing the release." \
		"  GITHUB_RELEASE=1          Create a GitHub Release with gh." \
		"  NPM_CONFIG_OTP=123456     Standard npm OTP config when 2FA is enabled."

test:
	npm test

pack:
	npm pack --dry-run

publish:
	@set -eu; \
	if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then \
		printf "Not a git repository.\n" >&2; \
		exit 1; \
	fi; \
	branch=$$(git symbolic-ref --quiet --short HEAD || true); \
	if [ -z "$$branch" ]; then \
		printf "Detached HEAD; refusing to publish.\n" >&2; \
		exit 1; \
	fi; \
	if ! git remote get-url "$(GIT_REMOTE)" >/dev/null 2>&1; then \
		printf "Remote '%s' is not configured.\n" "$(GIT_REMOTE)" >&2; \
		exit 1; \
	fi; \
	if [ "$(GITHUB_RELEASE)" = "1" ] && ! command -v gh >/dev/null 2>&1; then \
		printf "gh is required when GITHUB_RELEASE=1.\n" >&2; \
		exit 1; \
	fi; \
	name=$$(node -p "require('./package.json').name"); \
	current_version=$$(node -p "require('./package.json').version"); \
	status=$$(git status --porcelain); \
	if [ -n "$$status" ]; then \
		printf "Dirty worktree; commit/stash changes before publishing %s.\n" "$$name" >&2; \
		exit 1; \
	fi; \
	baseline_version=$$(npm view "$$name" version 2>/dev/null || true); \
	if [ -z "$$baseline_version" ]; then \
		baseline_version="$$current_version"; \
	fi; \
	release_type="$(VERSION)"; \
	if [ -z "$$release_type" ]; then \
		patch_version=$$(node scripts/resolve-version.js "$$baseline_version" patch); \
		minor_version=$$(node scripts/resolve-version.js "$$baseline_version" minor); \
		major_version=$$(node scripts/resolve-version.js "$$baseline_version" major); \
		printf "Current package version: %s\n" "$$current_version"; \
		printf "Latest release baseline: %s\n" "$$baseline_version"; \
		printf "Release type:\n"; \
		printf "  patch -> %s\n" "$$patch_version"; \
		printf "  minor -> %s\n" "$$minor_version"; \
		printf "  major -> %s\n" "$$major_version"; \
		while :; do \
			printf "Choose release type [patch/minor/major]: "; \
			IFS= read -r release_type; \
			case "$$release_type" in \
				patch|minor|major) break ;; \
				*) printf "Please choose patch, minor, or major.\n" >&2 ;; \
			esac; \
		done; \
	fi; \
	version=$$(node scripts/resolve-version.js "$$baseline_version" "$$release_type"); \
	if npm view "$$name@$$version" version >/dev/null 2>&1; then \
		printf "%s@%s is already published. Bump package.json before publishing.\n" "$$name" "$$version" >&2; \
		exit 1; \
	fi; \
	printf "Ready to release %s@%s.\n" "$$name" "$$version"; \
	npm test; \
	if [ "$$current_version" != "$$version" ]; then \
		npm version "$$version"; \
	fi; \
	name=$$(node -p "require('./package.json').name"); \
	version=$$(node -p "require('./package.json').version"); \
	tag="v$$version"; \
	if git rev-parse "$$tag" >/dev/null 2>&1; then \
		tag_commit=$$(git rev-list -n 1 "$$tag"); \
		head_commit=$$(git rev-parse HEAD); \
		if [ "$$tag_commit" != "$$head_commit" ]; then \
			printf "Tag %s exists but does not point at HEAD.\n" "$$tag" >&2; \
			exit 1; \
		fi; \
	else \
		git tag -a "$$tag" -m "$$name $$version"; \
	fi; \
	npm pack --dry-run; \
	printf "Publishing %s@%s to npm with tag %s...\n" "$$name" "$$version" "$(PUBLISH_TAG)"; \
	npm publish --access "$(PUBLISH_ACCESS)" --tag "$(PUBLISH_TAG)"; \
	branch=$$(git symbolic-ref --quiet --short HEAD); \
	if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then \
		git push; \
	else \
		git push -u "$(GIT_REMOTE)" "$$branch"; \
	fi; \
	git push "$(GIT_REMOTE)" "$$tag"; \
	if [ "$(GITHUB_RELEASE)" = "1" ]; then \
		if gh release view "$$tag" >/dev/null 2>&1; then \
			printf "GitHub Release %s already exists.\n" "$$tag"; \
		else \
			gh release create "$$tag" --title "$$tag" --generate-notes; \
		fi; \
	fi
