const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveBoardColumn,
  loadBoardTasks,
  ensurePrimaryPlanFile,
  markTaskReadyForReview,
  moveTask,
  readTask,
  returnTaskToDoingFromReview,
  setTaskStarted,
} = require('../lib/backlog');

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-backlog-'));
  for (const dir of ['todos/todo', 'todos/doing', 'todos/done', 'plans/todo', 'plans/doing', 'plans/done']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function writeTask(root, statusDir, filename, status, planStatusDir = statusDir) {
  const taskPath = path.join(root, 'todos', statusDir, filename);
  const planPath = path.join(root, 'plans', planStatusDir, filename);
  const taskContent = `---\ntitle: Example Task\nmain_goal: Example goal\nshort_description: Example description\ncreation_date: '2026-04-10'\nstart_date: null\nstatus: ${status}\nrepository:\n  - app\nbranch_name: []\nplans_files:\n  - plans/${planStatusDir}/${filename}\nlabels: []\n---\n\nBody`;
  const planContent = '# Plan\n\n- [ ] Step one\n- [x] Step two\n';
  fs.writeFileSync(taskPath, taskContent, 'utf-8');
  fs.writeFileSync(planPath, planContent, 'utf-8');
}

test('deriveBoardColumn maps ready_for_review tasks into review', () => {
  assert.equal(deriveBoardColumn('doing', ['ready_for_review']), 'review');
  assert.equal(deriveBoardColumn('doing', []), 'doing');
  assert.equal(deriveBoardColumn('done', ['ready_for_review']), 'done');
});

test('moving a task into doing keeps it staged until play starts work', () => {
  const root = makeTempRoot();
  writeTask(root, 'todo', 'example.md', 'to_start');

  const moved = moveTask(root, 'todo', 'example.md', 'doing');
  assert.equal(moved.storageColumn, 'doing');
  assert.equal(moved.status, 'to_start');
  assert.equal(moved.start_date, null);
  assert.deepEqual(moved.branch_name, []);
  assert.deepEqual(moved.plans_files, ['plans/doing/example.md']);

  assert.equal(fs.existsSync(path.join(root, 'todos', 'todo', 'example.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'plans', 'todo', 'example.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'todos', 'doing', 'example.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'plans', 'doing', 'example.md')), true);
});

test('starting a task populates work metadata and ready_for_review moves it into review', () => {
  const root = makeTempRoot();
  writeTask(root, 'doing', 'example.md', 'to_start', 'doing');

  const started = setTaskStarted(root, 'example.md', 'task/example', '2026-04-10');
  assert.equal(started.status, 'wip');
  assert.equal(started.start_date, '2026-04-10');
  assert.deepEqual(started.branch_name, ['task/example']);

  const reviewReady = markTaskReadyForReview(root, 'example.md');
  assert.equal(reviewReady.boardColumn, 'review');
  assert.ok(reviewReady.labels.includes('ready_for_review'));

  const reviewTask = readTask(root, 'review', 'example.md');
  assert.ok(reviewTask);
  assert.equal(reviewTask.boardColumn, 'review');

  const board = loadBoardTasks(root);
  assert.equal(board.review.length, 1);
});

test('returnTaskToDoingFromReview removes ready_for_review and keeps task active', () => {
  const root = makeTempRoot();
  writeTask(root, 'doing', 'example.md', 'wip', 'doing');

  const reviewReady = markTaskReadyForReview(root, 'example.md');
  assert.equal(reviewReady.boardColumn, 'review');

  const movedBack = returnTaskToDoingFromReview(root, 'example.md');
  assert.equal(movedBack.boardColumn, 'doing');
  assert.equal(movedBack.status, 'wip');
  assert.equal(movedBack.labels.includes('ready_for_review'), false);
});

test('moving a review task to doing removes review label without moving files', () => {
  const root = makeTempRoot();
  writeTask(root, 'doing', 'example.md', 'wip', 'doing');
  const started = setTaskStarted(root, 'example.md', 'task/example', '2026-04-10');
  assert.deepEqual(started.branch_name, ['task/example']);

  const reviewReady = markTaskReadyForReview(root, 'example.md');
  assert.equal(reviewReady.boardColumn, 'review');

  const moved = moveTask(root, 'review', 'example.md', 'doing');

  assert.equal(moved.storageColumn, 'doing');
  assert.equal(moved.boardColumn, 'doing');
  assert.equal(moved.status, 'wip');
  assert.equal(moved.start_date, '2026-04-10');
  assert.deepEqual(moved.branch_name, ['task/example']);
  assert.deepEqual(moved.plans_files, ['plans/doing/example.md']);
  assert.equal(moved.labels.includes('ready_for_review'), false);
  assert.equal(fs.existsSync(path.join(root, 'todos', 'doing', 'example.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'plans', 'doing', 'example.md')), true);
});

test('ensurePrimaryPlanFile creates and links a missing plan', () => {
  const root = makeTempRoot();
  writeTask(root, 'todo', 'example.md', 'to_start');
  fs.unlinkSync(path.join(root, 'plans', 'todo', 'example.md'));
  const taskPath = path.join(root, 'todos', 'todo', 'example.md');
  fs.writeFileSync(
    taskPath,
    fs.readFileSync(taskPath, 'utf-8').replace('plans_files:\n  - plans/todo/example.md', 'plans_files: []'),
    'utf-8',
  );

  const result = ensurePrimaryPlanFile(root, 'todo', 'example.md');

  assert.equal(result.created, true);
  assert.equal(result.planRef, 'plans/todo/example.md');
  assert.deepEqual(result.task.plans_files, ['plans/todo/example.md']);
  assert.equal(fs.existsSync(path.join(root, 'plans', 'todo', 'example.md')), true);
});
