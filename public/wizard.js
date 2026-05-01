const summary = document.getElementById('wizard-summary');
const rootNode = document.getElementById('wizard-root');
const rootCopyButton = document.getElementById('wizard-root-copy');
const dirsExistingGroup = document.getElementById('wizard-dirs-existing-group');
const dirsMissingGroup = document.getElementById('wizard-dirs-missing-group');
const dirsExisting = document.getElementById('wizard-dirs-existing');
const dirsMissing = document.getElementById('wizard-dirs-missing');
const dirsSkeleton = document.getElementById('wizard-dirs-skeleton');
const banner = document.getElementById('wizard-banner');
const legacyNote = document.getElementById('wizard-legacy-note');
const repoRows = document.getElementById('wizard-repo-rows');
const repoEmpty = document.getElementById('wizard-repo-empty');
const addRepoButton = document.getElementById('wizard-add-repo');
const advanced = document.getElementById('wizard-advanced');
const repositoriesNode = document.getElementById('wizard-repositories');
const createButton = document.getElementById('wizard-create');
const openLink = document.getElementById('wizard-open');
const refreshButton = document.getElementById('wizard-refresh');
const reposSection = document.getElementById('wizard-repos-section');

const REPO_NAME_RE = /^[\w.-]+$/;

const CTA_LABELS = {
  init: 'Create board',
  adopt: 'Adopt this folder',
  repair: 'Repair missing folders',
  repair_config: 'Fix config and continue',
  open: 'Open board',
};

const SUMMARY_TEXT = {
  init: 'No board found yet. Moirai can create one here.',
  adopt: 'Existing markdown board found. Moirai can adopt it.',
  repair: 'Partial board found. Moirai can create the missing folders.',
  repair_config: 'Config needs repair before the board can open.',
  open: 'This folder is ready.',
};

const state = {
  status: null,
  repos: [],
  advancedDirty: false,
  advancedSnapshot: '',
  suppressAdvancedToggle: false,
};

function showBanner(message) {
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function clearBanner() {
  banner.textContent = '';
  banner.classList.add('hidden');
}

function recommendedAction() {
  return state.status?.detection?.recommendedAction || 'init';
}

function setSkeleton(visible) {
  dirsSkeleton.classList.toggle('hidden', !visible);
  if (visible) {
    dirsExistingGroup.classList.add('hidden');
    dirsMissingGroup.classList.add('hidden');
  }
}

function renderDirs(detection) {
  dirsExisting.innerHTML = '';
  dirsMissing.innerHTML = '';
  setSkeleton(false);

  const existing = detection.structure.existingDirs || [];
  const missing = detection.structure.missingDirs || [];

  for (const dir of existing) {
    dirsExisting.appendChild(buildDirItem(dir, true));
  }
  for (const dir of missing) {
    dirsMissing.appendChild(buildDirItem(dir, false));
  }

  dirsExistingGroup.classList.toggle('hidden', existing.length === 0);
  dirsMissingGroup.classList.toggle('hidden', missing.length === 0);
}

function buildDirItem(dir, exists) {
  const li = document.createElement('li');
  li.className = 'wizard-dir';
  const badge = document.createElement('span');
  badge.className = `wizard-dir-badge ${exists ? 'is-ok' : 'is-missing'}`;
  badge.textContent = exists ? '✓' : '!';
  badge.setAttribute('aria-label', exists ? 'exists' : 'missing');
  const label = document.createElement('span');
  label.textContent = `${dir}/`;
  li.appendChild(badge);
  li.appendChild(label);
  return li;
}

function renderRepos() {
  repoRows.innerHTML = '';
  for (let i = 0; i < state.repos.length; i++) {
    repoRows.appendChild(buildRepoRow(state.repos[i], i));
  }
  const nonBacklog = state.repos.filter((r) => r.name !== 'backlog');
  repoEmpty.classList.toggle('hidden', nonBacklog.length > 0);
}

function buildRepoRow(repo, index) {
  const li = document.createElement('li');
  li.className = 'wizard-repo-row';
  li.dataset.index = String(index);

  const nameGroup = document.createElement('div');
  nameGroup.className = 'wizard-input-group';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'wizard-input';
  nameInput.value = repo.name;
  nameInput.placeholder = 'name';
  nameInput.setAttribute('aria-label', `Repository ${index + 1} name`);
  nameInput.spellcheck = false;
  nameInput.autocomplete = 'off';
  if (repo.locked) {
    nameInput.readOnly = true;
  }
  nameInput.addEventListener('input', () => {
    state.repos[index].name = nameInput.value.trim();
    state.advancedDirty = false;
    clearRowError(li);
  });
  nameInput.addEventListener('blur', () => validateRow(index));
  nameGroup.appendChild(nameInput);
  if (repo.current) {
    const tag = document.createElement('span');
    tag.className = 'wizard-row-tag';
    tag.textContent = 'this project';
    nameGroup.appendChild(tag);
  } else if (repo.locked) {
    const tag = document.createElement('span');
    tag.className = 'wizard-row-tag';
    tag.textContent = 'required';
    nameGroup.appendChild(tag);
  }

  const pathGroup = document.createElement('div');
  pathGroup.className = 'wizard-input-group';
  const pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'wizard-input';
  pathInput.value = repo.path;
  pathInput.placeholder = 'relative or absolute path';
  pathInput.setAttribute('aria-label', `Repository ${index + 1} path`);
  pathInput.spellcheck = false;
  pathInput.autocomplete = 'off';
  pathInput.addEventListener('input', () => {
    state.repos[index].path = pathInput.value;
    state.advancedDirty = false;
    clearRowError(li);
  });
  pathInput.addEventListener('blur', () => validateRow(index));
  pathGroup.appendChild(pathInput);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'wizard-row-remove';
  remove.setAttribute('aria-label', `Remove repository ${repo.name || index + 1}`);
  remove.textContent = '×';
  if (repo.locked) {
    remove.disabled = true;
  } else {
    remove.addEventListener('click', () => {
      state.repos.splice(index, 1);
      state.advancedDirty = false;
      renderRepos();
    });
  }

  li.appendChild(nameGroup);
  li.appendChild(pathGroup);
  li.appendChild(remove);
  return li;
}

function clearRowError(li) {
  li.classList.remove('has-error');
  const existing = li.querySelector('.wizard-input-error');
  if (existing) existing.remove();
}

function setRowError(li, message) {
  clearRowError(li);
  li.classList.add('has-error');
  const err = document.createElement('div');
  err.className = 'wizard-input-error';
  err.textContent = message;
  err.style.gridColumn = '1 / -1';
  li.appendChild(err);
}

function validateRow(index) {
  const li = repoRows.querySelector(`[data-index="${index}"]`);
  if (!li) return true;
  const repo = state.repos[index];
  if (!repo) return true;
  if (!repo.name) {
    setRowError(li, 'Name is required.');
    return false;
  }
  if (!REPO_NAME_RE.test(repo.name)) {
    setRowError(li, 'Use letters, numbers, dot, dash, or underscore only.');
    return false;
  }
  if (!repo.path || !repo.path.trim()) {
    setRowError(li, 'Path is required.');
    return false;
  }
  const dup = state.repos.findIndex((r, i) => i !== index && r.name === repo.name);
  if (dup !== -1) {
    setRowError(li, 'Duplicate name. Each repository must have a unique name.');
    return false;
  }
  return true;
}

function validateAllRows() {
  let firstInvalid = -1;
  for (let i = 0; i < state.repos.length; i++) {
    const ok = validateRow(i);
    if (!ok && firstInvalid === -1) firstInvalid = i;
  }
  return firstInvalid === -1
    ? { ok: true }
    : { ok: false, index: firstInvalid };
}

function reposToObject(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.name || !r.path) continue;
    out[r.name] = r.path.trim();
  }
  if (!out.backlog) out.backlog = '.';
  return out;
}

function reposToJson(rows) {
  return JSON.stringify(reposToObject(rows), null, 2);
}

function objectToRepoRows(obj, projectRoot) {
  const baseName = projectRoot ? projectRoot.split('/').filter(Boolean).pop() : '';
  const rows = [];
  const entries = Object.entries(obj || {});
  const backlogEntry = entries.find(([name]) => name === 'backlog');
  rows.push({
    name: 'backlog',
    path: backlogEntry ? backlogEntry[1] : '.',
    locked: true,
    current: false,
  });
  for (const [name, repoPath] of entries) {
    if (name === 'backlog') continue;
    rows.push({
      name,
      path: repoPath,
      locked: false,
      current: name === baseName && (repoPath === '.' || repoPath === ''),
    });
  }
  return rows;
}

function applyJsonToRows(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText || '{}');
  } catch (error) {
    return { ok: false, error: `Repository JSON is invalid: ${error.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Repository JSON must be an object mapping name → path.' };
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (!REPO_NAME_RE.test(name)) {
      return { ok: false, error: `Invalid repository name "${name}". Use letters, numbers, dot, dash, or underscore only.` };
    }
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, error: `Repository "${name}" needs a non-empty path.` };
    }
  }
  state.repos = objectToRepoRows(parsed, state.status?.detection?.projectRoot);
  return { ok: true };
}

function setCta(action) {
  const isOpen = action === 'open';
  if (isOpen) {
    createButton.classList.add('hidden');
    openLink.classList.remove('hidden');
    reposSection.classList.add('hidden');
  } else {
    createButton.classList.remove('hidden');
    openLink.classList.add('hidden');
    reposSection.classList.remove('hidden');
    createButton.textContent = CTA_LABELS[action] || CTA_LABELS.init;
  }
}

function renderStatus(status) {
  state.status = status;
  const detection = status.detection;
  const action = detection.recommendedAction;

  rootNode.textContent = detection.projectRoot;
  summary.textContent = SUMMARY_TEXT[action] || SUMMARY_TEXT.init;
  renderDirs(detection);

  legacyNote.classList.toggle('hidden', !detection.hasLegacyConfig);
  if (detection.hasLegacyConfig) {
    legacyNote.textContent = 'Legacy config detected at .moiraiboard.json. Moirai will continue using the new .moirai/config.json.';
  }

  if (detection.configError) {
    showBanner(`Config error: ${detection.configError}`);
  } else {
    clearBanner();
  }

  state.repos = objectToRepoRows(status.suggestedRepositories || { backlog: '.' }, detection.projectRoot);
  state.advancedDirty = false;
  renderRepos();
  if (advanced.open) {
    repositoriesNode.value = reposToJson(state.repos);
    state.advancedSnapshot = repositoriesNode.value;
  }

  setCta(action);

  if (action !== 'open') {
    requestAnimationFrame(() => createButton.focus());
  }
}

async function loadStatus() {
  setSkeleton(true);
  summary.textContent = 'Checking this folder…';
  try {
    const response = await fetch('/api/setup/status');
    if (!response.ok) throw new Error(`Could not load setup status (HTTP ${response.status}).`);
    renderStatus(await response.json());
  } catch (error) {
    setSkeleton(false);
    showBanner(error.message || String(error));
  }
}

function setBusy(busy) {
  createButton.disabled = busy;
  createButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  refreshButton.disabled = busy;
  addRepoButton.disabled = busy;
  for (const input of repoRows.querySelectorAll('input,button')) {
    if (input === createButton || input === refreshButton) continue;
    input.disabled = busy && !input.readOnly;
  }
}

async function initialize() {
  clearBanner();

  let payloadRepos;
  if (advanced.open && state.advancedDirty) {
    const result = applyJsonToRows(repositoriesNode.value);
    if (!result.ok) {
      showBanner(result.error);
      banner.focus();
      repositoriesNode.focus();
      return;
    }
    state.advancedDirty = false;
    state.advancedSnapshot = repositoriesNode.value;
    renderRepos();
  }

  const validation = validateAllRows();
  if (!validation.ok) {
    showBanner('Fix the highlighted repository fields and try again.');
    const li = repoRows.querySelector(`[data-index="${validation.index}"]`);
    const input = li?.querySelector('input');
    if (input) input.focus();
    return;
  }
  payloadRepos = reposToObject(state.repos);

  setBusy(true);
  const previousLabel = createButton.textContent;
  createButton.textContent = 'Creating…';

  try {
    const response = await fetch('/api/setup/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositories: payloadRepos,
        overwriteConfig: recommendedAction() === 'repair_config',
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `Setup failed (HTTP ${response.status}).`);
    }
    window.location.assign('/');
  } catch (error) {
    setBusy(false);
    createButton.textContent = previousLabel;
    showBanner(error.message || String(error));
    banner.focus();
  }
}

createButton.addEventListener('click', initialize);

refreshButton.addEventListener('click', () => {
  loadStatus();
});

addRepoButton.addEventListener('click', () => {
  state.repos.push({ name: '', path: '', locked: false, current: false });
  state.advancedDirty = false;
  renderRepos();
  const li = repoRows.querySelector(`[data-index="${state.repos.length - 1}"]`);
  const input = li?.querySelector('input');
  if (input) input.focus();
});

rootCopyButton.addEventListener('click', async () => {
  const text = rootNode.textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const original = rootCopyButton.textContent;
    rootCopyButton.textContent = '✓';
    rootCopyButton.classList.add('is-success');
    setTimeout(() => {
      rootCopyButton.textContent = original;
      rootCopyButton.classList.remove('is-success');
    }, 1200);
  } catch {
    showBanner('Could not copy path. Select and copy it manually.');
  }
});

repositoriesNode.addEventListener('input', () => {
  state.advancedDirty = repositoriesNode.value !== state.advancedSnapshot;
});

advanced.addEventListener('toggle', () => {
  if (state.suppressAdvancedToggle) {
    state.suppressAdvancedToggle = false;
    return;
  }
  if (advanced.open) {
    repositoriesNode.value = reposToJson(state.repos);
    state.advancedSnapshot = repositoriesNode.value;
    state.advancedDirty = false;
    requestAnimationFrame(() => repositoriesNode.focus());
  } else {
    if (state.advancedDirty) {
      const result = applyJsonToRows(repositoriesNode.value);
      if (!result.ok) {
        state.suppressAdvancedToggle = true;
        advanced.open = true;
        showBanner(result.error);
        repositoriesNode.focus();
        return;
      }
      state.advancedDirty = false;
      renderRepos();
      clearBanner();
    }
  }
});

loadStatus();
