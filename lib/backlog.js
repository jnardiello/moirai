const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { marked } = require('marked');

const STORAGE_COLUMNS = ['todo', 'doing', 'done'];
const BOARD_COLUMNS = ['todo', 'doing', 'review', 'done'];
const USER_LABELS = ['archived', 'critical', 'bug', 'improvement'];
const OPERATIONAL_LABELS = ['ready_for_review'];
const VALID_LABELS = [...USER_LABELS, ...OPERATIONAL_LABELS];
const FRONTMATTER_SEPARATOR = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function taskFilenameToId(filename) {
  return filename;
}

function getStorageColumnForBoardColumn(column) {
  if (column === 'review') {
    return 'doing';
  }
  return column;
}

function isValidStorageColumn(column) {
  return STORAGE_COLUMNS.includes(column);
}

function isValidBoardColumn(column) {
  return BOARD_COLUMNS.includes(column);
}

function deriveBoardColumn(storageColumn, labels = []) {
  if (storageColumn === 'doing' && labels.includes('ready_for_review')) {
    return 'review';
  }
  return storageColumn;
}

function taskDir(root, storageColumn) {
  return path.join(root, 'todos', storageColumn);
}

function planDir(root, storageColumn) {
  return path.join(root, 'plans', storageColumn);
}

function taskPath(root, storageColumn, filename) {
  return path.join(taskDir(root, storageColumn), filename);
}

function assertFilename(filename) {
  if (!/^[\w.-]+\.md$/.test(filename)) {
    throw new Error('invalid filename');
  }
}

function parseMarkdownWithFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const match = raw.match(FRONTMATTER_SEPARATOR);
  if (!match) {
    throw new Error('bad frontmatter');
  }

  return {
    raw,
    frontmatter: yaml.load(match[1]) || {},
    body: match[2],
  };
}

function serializeMarkdownWithFrontmatter(frontmatter, body) {
  return `---\n${yaml.dump(frontmatter, { lineWidth: -1 })}---\n${body ?? ''}`;
}

function writeMarkdownWithFrontmatter(filePath, frontmatter, body) {
  fs.writeFileSync(filePath, serializeMarkdownWithFrontmatter(frontmatter, body), 'utf-8');
}

function countCheckboxes(root, planPaths) {
  let done = 0;
  let total = 0;

  for (const planPathRef of planPaths || []) {
    const resolved = path.resolve(root, planPathRef);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
      continue;
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const checked = (content.match(/- \[x\]/gi) || []).length;
    const unchecked = (content.match(/- \[ \]/g) || []).length;
    done += checked;
    total += checked + unchecked;
  }

  return { todoDone: done, todoTotal: total };
}

function parseTaskFile(root, filePath, storageColumn) {
  const { frontmatter, body } = parseMarkdownWithFrontmatter(filePath);
  const trimmedBody = body.trim();
  const labels = Array.isArray(frontmatter.labels) ? frontmatter.labels : [];

  return {
    ...frontmatter,
    labels,
    body: trimmedBody,
    bodyHtml: trimmedBody ? marked.parse(trimmedBody) : '',
    storageColumn,
    boardColumn: deriveBoardColumn(storageColumn, labels),
    filename: path.basename(filePath),
    ...countCheckboxes(root, frontmatter.plans_files),
  };
}

function readTask(root, boardColumn, filename) {
  assertFilename(filename);
  if (!isValidBoardColumn(boardColumn)) {
    throw new Error('invalid column');
  }

  const storageColumn = getStorageColumnForBoardColumn(boardColumn);
  const filePath = taskPath(root, storageColumn, filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
    return null;
  }

  const task = parseTaskFile(root, resolved, storageColumn);
  if (task.boardColumn !== boardColumn) {
    return null;
  }
  return task;
}

function loadStorageColumn(root, storageColumn) {
  const dir = taskDir(root, storageColumn);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((filename) => filename.endsWith('.md'))
    .map((filename) => parseTaskFile(root, path.join(dir, filename), storageColumn))
    .sort((a, b) => (b.creation_date || '').localeCompare(a.creation_date || ''));
}

function loadBoardTasks(root) {
  const buckets = {
    todo: [],
    doing: [],
    review: [],
    done: [],
  };

  for (const storageColumn of STORAGE_COLUMNS) {
    const tasks = loadStorageColumn(root, storageColumn);
    for (const task of tasks) {
      if (storageColumn === 'done' && task.labels.includes('archived')) {
        continue;
      }
      buckets[task.boardColumn].push(task);
    }
  }

  return buckets;
}

function loadArchivedTasks(root) {
  return loadStorageColumn(root, 'done')
    .filter((task) => task.labels.includes('archived'));
}

function withTask(root, storageColumn, filename, updater) {
  assertFilename(filename);
  if (!isValidStorageColumn(storageColumn)) {
    throw new Error('invalid column');
  }

  const filePath = taskPath(root, storageColumn, filename);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) {
    throw new Error('not found');
  }

  const { frontmatter, body } = parseMarkdownWithFrontmatter(resolved);
  const next = updater({
    frontmatter: { ...frontmatter },
    body,
    filePath: resolved,
  });

  const nextFrontmatter = next?.frontmatter || frontmatter;
  const nextBody = Object.prototype.hasOwnProperty.call(next || {}, 'body') ? next.body : body;
  writeMarkdownWithFrontmatter(resolved, nextFrontmatter, nextBody);

  return parseTaskFile(root, resolved, storageColumn);
}

function updateTaskLabels(root, storageColumn, filename, labels) {
  if (!Array.isArray(labels) || !labels.every((label) => VALID_LABELS.includes(label))) {
    throw new Error('invalid label value');
  }

  return withTask(root, storageColumn, filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      labels: [...new Set(labels)],
    },
    body,
  }));
}

function updateTaskFields(root, storageColumn, filename, fields, body) {
  const editableFields = ['title', 'main_goal', 'short_description'];

  return withTask(root, storageColumn, filename, ({ frontmatter, body: existingBody }) => {
    const nextFrontmatter = { ...frontmatter };
    for (const [key, value] of Object.entries(fields || {})) {
      if (editableFields.includes(key) && typeof value === 'string') {
        nextFrontmatter[key] = value;
      }
    }

    return {
      frontmatter: nextFrontmatter,
      body: typeof body === 'string' ? body : existingBody,
    };
  });
}

function ensurePrimaryPlanFile(root, boardColumn, filename) {
  const task = readTask(root, boardColumn, filename);
  if (!task) {
    throw new Error('not found');
  }

  const existingPlan = Array.isArray(task.plans_files) && task.plans_files[0] ? task.plans_files[0] : null;
  if (existingPlan) {
    return {
      task,
      planRef: existingPlan,
      created: false,
    };
  }

  const storageColumn = getStorageColumnForBoardColumn(boardColumn);
  const planFilename = filename;
  const planRef = `plans/${storageColumn}/${planFilename}`;
  const planPath = path.join(planDir(root, storageColumn), planFilename);
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  if (!fs.existsSync(planPath)) {
    fs.writeFileSync(planPath, `# ${task.title || filename}\n\n`, 'utf-8');
  }

  const updatedTask = withTask(root, storageColumn, filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      plans_files: [planRef],
    },
    body,
  }));

  return {
    task: updatedTask,
    planRef,
    created: true,
  };
}

function movePlanFiles(root, frontmatter, toStorageColumn) {
  const nextPlanRefs = [];
  for (const planRef of frontmatter.plans_files || []) {
    const currentPlanPath = path.resolve(root, planRef);
    if (!currentPlanPath.startsWith(root + path.sep) || !fs.existsSync(currentPlanPath)) {
      nextPlanRefs.push(planRef);
      continue;
    }

    const planFilename = path.basename(planRef);
    const destinationDir = planDir(root, toStorageColumn);
    const destinationPath = path.join(destinationDir, planFilename);
    if (path.resolve(destinationPath) !== currentPlanPath) {
      if (fs.existsSync(destinationPath)) {
        throw new Error(`destination plan already exists for ${planFilename}`);
      }
      fs.renameSync(currentPlanPath, destinationPath);
    }
    nextPlanRefs.push(`plans/${toStorageColumn}/${planFilename}`);
  }
  return nextPlanRefs;
}

function normalizeLabels(labels = [], toStorageColumn) {
  const deduped = [...new Set(labels)];
  if (toStorageColumn !== 'doing') {
    return deduped.filter((label) => label !== 'ready_for_review');
  }
  return deduped;
}

function computeMoveFrontmatter(frontmatter, toStorageColumn) {
  const nextFrontmatter = {
    ...frontmatter,
    labels: normalizeLabels(frontmatter.labels, toStorageColumn),
  };

  if (toStorageColumn === 'todo') {
    nextFrontmatter.status = 'to_start';
    nextFrontmatter.start_date = null;
    nextFrontmatter.branch_name = [];
  } else if (toStorageColumn === 'doing') {
    nextFrontmatter.status = 'to_start';
    nextFrontmatter.start_date = null;
    nextFrontmatter.branch_name = [];
  } else if (toStorageColumn === 'done') {
    nextFrontmatter.status = 'done';
    nextFrontmatter.branch_name = [];
  }

  return nextFrontmatter;
}

function moveTask(root, fromBoardColumn, filename, toBoardColumn) {
  assertFilename(filename);
  if (!isValidBoardColumn(fromBoardColumn) || !isValidBoardColumn(toBoardColumn) || fromBoardColumn === toBoardColumn) {
    throw new Error('invalid columns');
  }
  if (toBoardColumn === 'review') {
    throw new Error('cannot move directly into review');
  }

  const fromStorageColumn = getStorageColumnForBoardColumn(fromBoardColumn);
  const toStorageColumn = getStorageColumnForBoardColumn(toBoardColumn);
  if (!isValidStorageColumn(fromStorageColumn) || !isValidStorageColumn(toStorageColumn) || fromStorageColumn === toStorageColumn && fromBoardColumn !== fromStorageColumn) {
    // Review is a derived board column backed by todos/doing plus the ready_for_review label.
    // Moving review -> doing only removes that operational label; no files move on disk.
    if (
      (fromBoardColumn === 'review' && toBoardColumn === 'done')
      || (fromBoardColumn === 'review' && toBoardColumn === 'doing')
    ) {
      // allowed
    } else if (fromStorageColumn === toStorageColumn) {
      throw new Error('invalid columns');
    }
  }

  const sourcePath = taskPath(root, fromStorageColumn, filename);
  const resolvedSource = path.resolve(sourcePath);
  if (!resolvedSource.startsWith(root + path.sep) || !fs.existsSync(resolvedSource)) {
    throw new Error('not found');
  }

  const { frontmatter, body } = parseMarkdownWithFrontmatter(resolvedSource);
  const nextFrontmatter = computeMoveFrontmatter(frontmatter, toStorageColumn);
  if (fromBoardColumn === 'review' && toBoardColumn === 'doing') {
    nextFrontmatter.status = 'wip';
    nextFrontmatter.start_date = frontmatter.start_date ?? null;
    nextFrontmatter.branch_name = Array.isArray(frontmatter.branch_name) ? frontmatter.branch_name : [];
    nextFrontmatter.labels = normalizeLabels(frontmatter.labels, 'doing').filter((label) => label !== 'ready_for_review');
  }
  nextFrontmatter.plans_files = movePlanFiles(root, nextFrontmatter, toStorageColumn);

  const destinationPath = taskPath(root, toStorageColumn, filename);
  if (fs.existsSync(destinationPath) && path.resolve(destinationPath) !== resolvedSource) {
    throw new Error('destination file already exists');
  }

  writeMarkdownWithFrontmatter(destinationPath, nextFrontmatter, body);
  if (path.resolve(destinationPath) !== resolvedSource) {
    fs.unlinkSync(resolvedSource);
  }

  return parseTaskFile(root, destinationPath, toStorageColumn);
}

function setTaskStarted(root, filename, branchName, startDate) {
  return withTask(root, 'doing', filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      status: 'wip',
      start_date: startDate,
      branch_name: [branchName],
      labels: normalizeLabels(frontmatter.labels, 'doing').filter((label) => label !== 'ready_for_review'),
    },
    body,
  }));
}

function markTaskReadyForReview(root, filename) {
  return withTask(root, 'doing', filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      status: 'wip',
      labels: [...new Set([...(frontmatter.labels || []), 'ready_for_review'])],
    },
    body,
  }));
}

function returnTaskToDoingFromReview(root, filename) {
  return withTask(root, 'doing', filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      status: 'wip',
      labels: normalizeLabels(frontmatter.labels, 'doing').filter((label) => label !== 'ready_for_review'),
    },
    body,
  }));
}

function markTaskBlocked(root, filename) {
  return withTask(root, 'doing', filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      status: 'blocked',
      labels: normalizeLabels(frontmatter.labels, 'doing').filter((label) => label !== 'ready_for_review'),
    },
    body,
  }));
}

function markTaskInProgress(root, filename) {
  return withTask(root, 'doing', filename, ({ frontmatter, body }) => ({
    frontmatter: {
      ...frontmatter,
      status: 'wip',
      labels: normalizeLabels(frontmatter.labels, 'doing').filter((label) => label !== 'ready_for_review'),
    },
    body,
  }));
}

module.exports = {
  BOARD_COLUMNS,
  STORAGE_COLUMNS,
  USER_LABELS,
  VALID_LABELS,
  deriveBoardColumn,
  getStorageColumnForBoardColumn,
  isValidBoardColumn,
  isValidStorageColumn,
  loadBoardTasks,
  loadArchivedTasks,
  readTask,
  ensurePrimaryPlanFile,
  updateTaskLabels,
  updateTaskFields,
  moveTask,
  setTaskStarted,
  markTaskReadyForReview,
  returnTaskToDoingFromReview,
  markTaskBlocked,
  markTaskInProgress,
  taskFilenameToId,
};
