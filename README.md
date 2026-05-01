# Moirai

Moirai is a local agentic kanban board for markdown backlogs and coding agents.

It reads tasks from root-level `todos/` folders, reads implementation plans from root-level `plans/` folders, and keeps its own project configuration in `.moirai/config.json`.

## Install

Run it once with npx:

```sh
npx @jnardiello/moirai
```

Or install the CLI globally:

```sh
npm install -g @jnardiello/moirai
moirai
```

## First Run

Start Moirai inside the folder that should hold the board:

```sh
cd my-project
moirai
```

Moirai detects the current folder and opens a web wizard when setup is needed. The wizard can create or repair:

```text
todos/todo/
todos/doing/
todos/done/
plans/todo/
plans/doing/
plans/done/
.moirai/config.json
```

It does not create demo stories or copy backlog markdown into the Moirai package.

## Daily Use

```sh
moirai
```

Useful commands:

```sh
moirai init
moirai doctor
moirai --root /path/to/project --port 3001
```

Runtime logs, local agent discovery, and worktrees live under `.moirai/runtime/` and `.moirai/local.json`.

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
    "backlog": "."
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

## Development

```sh
npm install
npm test
npm start
```
