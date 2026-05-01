<p align="center">
  <img src="public/logo-moirai.png" alt="Moirai logo" width="240">
</p>

<h1 align="center">Moirai</h1>

<p align="center">
  A local agentic kanban board for markdown backlogs and coding agents.
</p>

Moirai turns a plain folder of Markdown tasks and implementation plans into a local web board. It is built for people who want the project-management source of truth to stay in git while still getting a focused UI for planning, agent execution, review, and archive workflows.

It reads tasks from `todos/`, plans from `plans/`, and stores local runtime state under `.moirai/`.

## Quick Start

You need Node.js 20 or newer.

Run Moirai in the folder that should contain your board:

```sh
npx @jnardiello/moirai
```

Or install it globally:

```sh
npm install -g @jnardiello/moirai
moirai
```

On first run, Moirai opens a setup wizard when the current folder is not initialized yet. The wizard can create or repair the expected board structure and `.moirai/config.json`.

## The Mental Model

Moirai is local-first:

- Your backlog is Markdown in your repository.
- The browser UI is a view and control surface over those files.
- Task status comes from file location plus task labels.
- Agent runs, logs, generated artifacts, and worktrees live in `.moirai/runtime/`.
- `.moirai/local.json` stores local machine-specific agent discovery.

The default board structure is:

```text
todos/todo/
todos/doing/
todos/done/
plans/todo/
plans/doing/
plans/done/
.moirai/config.json
```

Every task is a Markdown file inside one of the `todos/` status folders. Every implementation plan is a Markdown file inside the matching `plans/` status folder.

## Daily Workflow

Start the board:

```sh
moirai
```

Then use the UI to:

1. Open a task from the board.
2. Read or edit the task details.
3. Generate, inspect, request changes to, or approve the implementation plan.
4. Start an agent run once the plan is ready.
5. Follow activity, terminal output, and raw logs from the task detail view.
6. Move work through `todo`, `doing`, review, done, and archive.

The Review column is derived from tasks stored in `todos/doing/` with the `ready_for_review` label. Archived tasks are completed tasks in `todos/done/` with the `archived` label.

## Task Files

A task file must have YAML frontmatter and can have Markdown body content:

```md
---
title: Add billing
main_goal: As a user, I can subscribe to a plan so access matches billing state.
short_description: Add hosted billing and checkout.
creation_date: 2026-05-01
start_date: null
status: to_start
repository:
  - my-app
branch_name: []
plans_files:
  - plans/todo/add-billing.md
labels: []
---

# Context

Why this task exists and any useful product notes.
```

Useful task conventions:

- `plans_files` links task cards to implementation plans.
- `repository` names should match entries in `.moirai/config.json`.
- `branch_name` is filled when implementation work starts.
- `labels` supports `critical`, `bug`, `improvement`, `ready_for_review`, and `archived`.

## Plan Files

Plan files are normal Markdown. Moirai reads checkboxes in linked plans to show progress on cards:

```md
# Add billing

## TODO

- [ ] Define the checkout contract.
- [ ] Add automated tests.
- [ ] Implement the billing flow.
- [ ] Run validation.
```

Keep task files short and user-story focused. Put implementation detail, technical analysis, and step-by-step execution notes in the linked plan file.

## Agents

Moirai can discover and use local coding-agent CLIs such as:

- `codex`
- `claude`
- `opencode`

Agent commands must be installed on your machine and available on `PATH`. Configure repositories and agents in `.moirai/config.json`; Moirai uses that config to decide where agent worktrees and commands should run.

## CLI Reference

```sh
moirai
moirai init
moirai doctor
moirai --root /path/to/project
moirai --port 3001
moirai --host 127.0.0.1
moirai --no-open
moirai --no-update-check
moirai --version
```

Common commands:

- `moirai` starts the board or opens setup when needed.
- `moirai init` initializes or repairs a board folder.
- `moirai doctor` checks config, required folders, repository paths, and agent commands.
- `--root` opens a board from another folder.
- `--port` changes the local server port.
- `--no-update-check` skips the npm update check.

Set `MOIRAI_NO_UPDATE_CHECK=1` to disable update checks through the environment.

## Configuration

Example `.moirai/config.json`:

```json
{
  "schemaVersion": 1,
  "boardRoot": ".",
  "tasksDir": "todos",
  "plansDir": "plans",
  "runtimeDir": ".moirai/runtime",
  "worktreeRoot": ".moirai/runtime/worktrees",
  "repoBaseDir": ".",
  "defaultBaseBranch": "master",
  "repos": {
    "backlog": ".",
    "my-app": "../my-app"
  },
  "agents": {
    "codex": { "command": "codex" },
    "claude": { "command": "claude" },
    "opencode": { "command": "opencode" }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 3001
  }
}
```

`repos.backlog` points to the folder containing `todos/` and `plans/`. Add implementation repositories to `repos` when task frontmatter references them.

## Troubleshooting

Run a health check first:

```sh
moirai doctor
```

Common fixes:

- Setup wizard appears unexpectedly: start Moirai from the board root or pass `--root`.
- A port is already in use: pass `--port 3002`.
- An agent is missing: install its CLI and make sure the command is on `PATH`.
- Runtime files are noisy: keep `.moirai/runtime/` and `.moirai/local.json` out of git.
- Update checks are unwanted: use `--no-update-check` or `MOIRAI_NO_UPDATE_CHECK=1`.

## Development

```sh
npm install
npm test
npm start
```

`npm start` runs `node bin/moirai.js --no-open` from the current repository.

## Release

```sh
make publish
```

`make publish` requires a clean worktree, runs tests, creates or reuses the release tag, previews the npm package, publishes to npm, pushes the branch and tag, and creates a GitHub Release through `gh`.

When no version is provided, the Makefile asks whether the release is patch, minor, or major. To skip the prompt:

```sh
make publish VERSION=patch
```

If npm requires two-factor authentication:

```sh
NPM_CONFIG_OTP=123456 make publish
```
