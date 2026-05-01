const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadBoardConfig, moiraiConfigPath } = require('../lib/config');

test('repo paths resolve from .moirai/config.json in the project root', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moirai-config-'));
  const projectRoot = path.join(workspaceRoot, 'backlog');
  const appRoot = path.join(workspaceRoot, 'app');

  fs.mkdirSync(path.dirname(moiraiConfigPath(projectRoot)), { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(moiraiConfigPath(projectRoot), JSON.stringify({
    schemaVersion: 1,
    boardRoot: '.',
    repoBaseDir: '.',
    repos: {
      backlog: '.',
      app: '../app',
    },
  }, null, 2));

  const config = loadBoardConfig(projectRoot);
  assert.equal(config.boardRoot, projectRoot);
  assert.equal(config.repos.backlog, projectRoot);
  assert.equal(config.repos.app, appRoot);
  assert.equal(config.runtimeDir, path.join(projectRoot, '.moirai', 'runtime'));
});

test('legacy agent-config.json remains readable for migration safety', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moirai-legacy-config-'));
  const projectRoot = path.join(workspaceRoot, 'backlog');
  const appRoot = path.join(workspaceRoot, 'app');

  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(appRoot, { recursive: true });

  fs.writeFileSync(path.join(projectRoot, 'agent-config.json'), JSON.stringify({
    repoBaseDir: '.',
    repos: {
      backlog: '.',
      app: '../app',
    },
  }, null, 2));

  const config = loadBoardConfig(projectRoot);
  assert.equal(config.repos.backlog, projectRoot);
  assert.equal(config.repos.app, appRoot);
});
