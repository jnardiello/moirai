const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectProject,
  doctorProject,
  initializeProject,
  REQUIRED_BOARD_DIRS,
} = require('../lib/project');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moirai-project-'));
}

test('detectProject reports a fresh folder', () => {
  const root = tempRoot();
  const detection = detectProject(root);
  assert.equal(detection.structure.status, 'fresh');
  assert.equal(detection.recommendedAction, 'init');
  assert.deepEqual(detection.structure.missingDirs, REQUIRED_BOARD_DIRS);
});

test('initializeProject creates only structure and Moirai config', () => {
  const root = tempRoot();
  const result = initializeProject(root, {
    repositories: {
      backlog: '.',
      app: '../app',
    },
  });

  assert.equal(result.wroteConfig, true);
  for (const dir of REQUIRED_BOARD_DIRS) {
    assert.equal(fs.existsSync(path.join(root, dir)), true);
  }
  assert.equal(fs.existsSync(path.join(root, '.moirai', 'config.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'todos', 'todo', 'example.md')), false);

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8');
  assert.match(gitignore, /\.moirai\/runtime\//);
  assert.match(gitignore, /\.moirai\/local\.json/);
});

test('doctorProject reports a complete initialized board as ok', () => {
  const root = tempRoot();
  initializeProject(root, { repositories: { backlog: '.' } });
  const result = doctorProject(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});
