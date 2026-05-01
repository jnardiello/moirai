const board = document.getElementById('board');
const archiveView = document.getElementById('archive-view');
const taskView = document.getElementById('task-view');
const taskContent = document.getElementById('task-content');
const agentBar = document.getElementById('agent-bar');
const interactionHeader = document.getElementById('interaction-header');
const interactionPlan = document.getElementById('interaction-plan');
const interactionTranscript = document.getElementById('interaction-transcript');
const interactionRaw = document.getElementById('interaction-raw');
const interactionRawContent = document.getElementById('interaction-raw-content');
const interactionTerminal = document.getElementById('interaction-terminal');
const interactionInput = document.getElementById('interaction-input');
const navLogo = document.getElementById('nav-logo');
const navBoard = document.getElementById('nav-board');
const navArchive = document.getElementById('nav-archive');
const planTabButton = document.getElementById('tab-plan');
const transcriptTabButton = document.getElementById('tab-transcript');
const terminalTabButton = document.getElementById('tab-terminal');
const rawTabButton = document.getElementById('tab-raw');

const COLUMN_ORDER = ['todo', 'doing', 'review', 'done'];
const COLUMN_LABELS = {
  todo: 'To Do',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
};

const STATUS_LABELS = {
  to_start: 'Staged',
  wip: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
};

const RUN_STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  awaiting_input: 'Waiting For You',
  stopping: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

const LABEL_OPTIONS = ['critical', 'bug', 'improvement', 'archived'];
const SECTION_LABELS = { plan: 'Planning', implementation: 'Implementation', validate: 'Validate', review: 'Validate' };
const AGENT_FALLBACKS = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

// Models and efforts are loaded dynamically from the server via /api/agents

let availableAgents = [];
let lastBoardData = null;
let lastArchiveData = null;
let currentTask = null;
let boardPollTimer = null;
let taskPollTimer = null;
let activeRunSocket = null;
let currentRunId = null;
let currentRunMeta = null;
let currentRunEvents = [];
let currentRawLog = '';
let currentInteractionTab = 'transcript';
let currentPlanPath = null;
let currentPlanRaw = '';
let currentPlanDirty = false;
let currentPlanLoadToken = 0;
let currentPlanFeedbackHistory = [];
let planRefinementOpen = false;
let planRefinementDraftInput = '';
let planRefinementTaskFilename = null;
let activeDraftSocket = null;
let draftPlanEvents = [];
let phaseElapsedTimer = null;
let activeTerm = null;
let activeTermWs = null;
let activeTermResizeObserver = null;
let activeTerminalTaskId = null;
let cachedManualTestInstructions = null;
let manualTestRunId = null;
let transientPhaseValidation = {};

const activeFilters = {
  todo: [],
  doing: [],
  review: [],
  done: [],
};

const sortOrder = {
  todo: 'newest',
  doing: 'newest',
  review: 'newest',
  done: 'newest',
};

let archiveFilter = [];
let archiveSort = 'newest';

function navigateToBoard(event) {
  event.preventDefault();
  showView('board');
}

navLogo.addEventListener('click', navigateToBoard);
navBoard.addEventListener('click', navigateToBoard);

navArchive.addEventListener('click', (event) => {
  event.preventDefault();
  showView('archive');
});

planTabButton.addEventListener('click', () => switchInteractionTab('plan').catch((error) => console.error('Tab switch failed:', error)));
transcriptTabButton.addEventListener('click', () => switchInteractionTab('transcript').catch((error) => console.error('Tab switch failed:', error)));
terminalTabButton.addEventListener('click', () => switchInteractionTab('terminal').catch((error) => console.error('Tab switch failed:', error)));
rawTabButton.addEventListener('click', () => switchInteractionTab('raw').catch((error) => console.error('Tab switch failed:', error)));

interactionHeader.addEventListener('click', async (event) => {
  const startButton = event.target.closest('#agent-start');
  if (startButton) {
    if (!currentTask || startButton.disabled) {
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const issue = await readApiError(response);
        if (issue?.phase) {
          setTransientPhaseValidation(issue);
        }
        throw new Error(issue.error || 'Failed to start run');
      }
      clearTransientPhaseValidation();
      await refreshCurrentTask(true);
    } catch (error) {
      console.error('Run start failed:', error);
    }
    return;
  }

  const restartButton = event.target.closest('#agent-restart');
  if (restartButton) {
    if (!currentTask || restartButton.disabled) {
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const issue = await readApiError(response);
        if (issue?.phase) {
          setTransientPhaseValidation(issue);
        }
        throw new Error(issue.error || 'Failed to restart run');
      }
      clearTransientPhaseValidation();
      await refreshCurrentTask(true);
      await switchInteractionTab('transcript');
    } catch (error) {
      console.error('Run restart failed:', error);
    }
    return;
  }

  const stopButton = event.target.closest('#agent-stop');
  if (stopButton) {
    if (!currentTask || stopButton.disabled) {
      return;
    }
    const runId = currentTask.runtime?.activeRunId;
    if (!runId) {
      return;
    }
    try {
      const response = await fetch(`/api/runs/${runId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error('stop failed');
      }
      await refreshCurrentTask(true);
    } catch (error) {
      console.error('Run stop failed:', error);
    }
  }
});

function agentLabel(agentId) {
  const match = availableAgents.find((agent) => agent.id === agentId);
  return match?.label || AGENT_FALLBACKS[agentId] || agentId || 'Unassigned';
}

function formatRunStatus(status) {
  return RUN_STATUS_LABELS[status] || status || 'Idle';
}

function formatTimestamp(value) {
  if (!value) {
    return 'N/A';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function phaseChip(run) {
  if (!run?.phaseLabel) {
    return '';
  }
  return `<span class="badge badge-phase">${esc(run.phaseLabel)}</span>`;
}

function runChip(run) {
  if (!run?.status) {
    return '';
  }
  return `<span class="badge badge-run badge-run-${esc(run.status)}">${esc(formatRunStatus(run.status))}</span>`;
}

function waitingChip(run) {
  if (!run?.waitingForInput) {
    return '';
  }
  return '<span class="badge badge-waiting">Input Required</span>';
}

function agentChip(agentId) {
  if (!agentId) {
    return '';
  }
  return `<span class="badge badge-agent">${esc(agentLabel(agentId))}</span>`;
}

function modelLabel(agentId, model) {
  if (!agentId || !model) {
    return model || '';
  }
  const entry = getModelCatalog(agentId).find((item) => item.slug === model);
  return entry?.label || model;
}

function normalizePhaseSelection(selection = {}, fallback = {}) {
  return {
    agentId: selection.agentId || fallback.agentId || '',
    model: selection.model || fallback.model || '',
    effort: selection.effort || fallback.effort || '',
  };
}

function getRuntimePhaseConfig(runtime = {}) {
  const fallback = normalizePhaseSelection({
    agentId: runtime.assignedAgent,
    model: runtime.model,
    effort: runtime.effort,
  });
  const phaseConfig = runtime.phaseConfig || {};
  return {
    planning: normalizePhaseSelection(phaseConfig.planning, fallback),
    implementing: normalizePhaseSelection(phaseConfig.implementing, fallback),
    validate: normalizePhaseSelection(phaseConfig.validate, fallback),
  };
}

function getPhaseSelection(runtime, phaseKey) {
  return getRuntimePhaseConfig(runtime)[phaseKey] || normalizePhaseSelection();
}

function getPrimaryTaskAgent(runtime, run) {
  return run?.phaseSelection?.agentId
    || getPhaseSelection(runtime, 'planning').agentId
    || runtime.assignedAgent
    || '';
}

async function loadAgents() {
  try {
    const response = await fetch('/api/agents');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    availableAgents = data.agents || [];
  } catch (error) {
    console.error('Agent load failed:', error);
    availableAgents = Object.entries(AGENT_FALLBACKS).map(([id, label]) => ({ id, label }));
  }
}

async function fetchBoardData() {
  const response = await fetch('/api/tasks');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  lastBoardData = data;
  return data;
}

async function initBoard() {
  const data = await fetchBoardData();
  renderBoard(data);
}

function applyFilterSort(tasks, column) {
  let filtered = tasks;
  if (activeFilters[column].length > 0) {
    filtered = filtered.filter((task) => {
      const labels = task.labels || [];
      return activeFilters[column].every((label) => labels.includes(label));
    });
  }

  const sorted = [...filtered];
  if (sortOrder[column] === 'oldest') {
    sorted.sort((left, right) => (left.creation_date || '').localeCompare(right.creation_date || ''));
  } else {
    sorted.sort((left, right) => (right.creation_date || '').localeCompare(left.creation_date || ''));
  }
  return sorted;
}

function renderToolbar(column) {
  const pills = LABEL_OPTIONS
    .map((label) => {
      const active = activeFilters[column].includes(label);
      return `<button class="filter-pill label-${label}${active ? ' filter-pill-active' : ''}" data-column="${column}" data-label="${label}">${label}</button>`;
    })
    .join('');

  return `
    <div class="column-toolbar">
      <div class="filter-pills">${pills}</div>
    </div>
  `;
}

function renderBoard(data) {
  board.innerHTML = '';

  for (const columnKey of COLUMN_ORDER) {
    const tasks = data[columnKey] || [];
    const filtered = applyFilterSort(tasks, columnKey);
    const column = document.createElement('section');
    column.className = `column column-${columnKey}`;
    column.dataset.column = columnKey;

    const countLabel = activeFilters[columnKey].length > 0 && filtered.length !== tasks.length
      ? `${filtered.length} / ${tasks.length}`
      : `${tasks.length}`;

    const sortLabel = sortOrder[columnKey] === 'newest' ? 'Newest' : 'Oldest';
    const archiveAllMarkup = columnKey === 'done' && filtered.length > 0
      ? '<button class="btn-archive-all" id="archive-all-button">Archive all</button>'
      : '';

    column.innerHTML = `
      <div class="column-header">
        <span class="column-title">${COLUMN_LABELS[columnKey]}</span>
        <span class="column-count">${countLabel}</span>
        <button class="toolbar-sort" data-column="${columnKey}">${sortLabel}</button>
        ${archiveAllMarkup}
      </div>
      ${renderToolbar(columnKey)}
    `;

    if (columnKey !== 'review') {
      column.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        column.classList.add('column-drag-over');
      });

      column.addEventListener('dragleave', (event) => {
        if (!column.contains(event.relatedTarget)) {
          column.classList.remove('column-drag-over');
        }
      });

      column.addEventListener('drop', async (event) => {
        event.preventDefault();
        column.classList.remove('column-drag-over');
        let payload = null;
        try {
          payload = JSON.parse(event.dataTransfer.getData('text/plain'));
        } catch {
          return;
        }

        if (!payload?.boardColumn || !payload?.filename || payload.boardColumn === columnKey) {
          return;
        }

        try {
          const response = await fetch(`/api/tasks/${payload.boardColumn}/${payload.filename}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toColumn: columnKey }),
          });
          if (!response.ok) {
            throw new Error(await response.text());
          }
          const nextData = await fetchBoardData();
          renderBoard(nextData);
          if (currentTask?.filename === payload.filename) {
            const updated = findTaskByFilename(nextData, payload.filename);
            if (updated) {
              openDetail(updated, { preserveInteraction: true });
            }
          }
        } catch (error) {
          console.error('Move error:', error);
        }
      });
    }

    column.querySelectorAll('.filter-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const label = pill.dataset.label;
        const index = activeFilters[columnKey].indexOf(label);
        if (index >= 0) {
          activeFilters[columnKey].splice(index, 1);
        } else {
          activeFilters[columnKey].push(label);
        }
        renderBoard(lastBoardData);
      });
    });

    column.querySelector('.toolbar-sort').addEventListener('click', () => {
      sortOrder[columnKey] = sortOrder[columnKey] === 'newest' ? 'oldest' : 'newest';
      renderBoard(lastBoardData);
    });

    const archiveAllButton = column.querySelector('#archive-all-button');
    if (archiveAllButton) {
      archiveAllButton.addEventListener('click', async () => {
        await Promise.all(filtered.map((task) => {
          const labels = [...new Set([...(task.labels || []), 'archived'])];
          return fetch(`/api/tasks/done/${task.filename}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labels }),
          });
        }));
        const nextData = await fetchBoardData();
        renderBoard(nextData);
      });
    }

    filtered.forEach((task) => {
      column.appendChild(renderCard(task));
    });

    board.appendChild(column);
  }
}

function renderLabels(labels) {
  return (labels || [])
    .map((label) => `<span class="label-pill label-${esc(label)}">${esc(label)}</span>`)
    .join('');
}

function renderCard(task) {
  const card = document.createElement('article');
  const status = task.status || 'to_start';
  const runtime = task.runtime || {};
  const run = runtime.run;
  card.className = `card card-${status}`;
  if (status === 'blocked') {
    card.classList.add('card-blocked');
  }
  if (task.boardColumn === 'review') {
    card.classList.add('card-review');
  }

  card.setAttribute('draggable', 'true');
  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', JSON.stringify({
      filename: task.filename,
      boardColumn: task.boardColumn,
      storageColumn: task.storageColumn,
    }));
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('card-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('card-dragging');
  });

  const repos = (task.repository || [])
    .map((repo) => `<span class="repo-pill">${esc(repo)}</span>`)
    .join('');
  const planCount = (task.plans_files || []).length;
  const progressHtml = task.todoTotal > 0
    ? `
      <div class="progress-wrapper">
        <div class="progress-bar"><div class="progress-fill" style="width: ${Math.round((task.todoDone / task.todoTotal) * 100)}%"></div></div>
        <span class="progress-label">${task.todoDone}/${task.todoTotal}</span>
      </div>
    `
    : '';

  card.innerHTML = `
    <div class="card-title">${esc(task.title)}</div>
    <div class="card-meta">
      <span class="badge badge-${status}">${STATUS_LABELS[status] || status}</span>
      ${renderLabels(task.labels)}
      ${agentChip(getPrimaryTaskAgent(runtime, run))}
      ${runChip(run)}
      ${phaseChip(run)}
      ${waitingChip(run)}
      ${repos}
      <span class="card-date">${esc(task.creation_date || '')}</span>
      <span class="plan-count">${planCount === 1 ? '1 plan' : `${planCount} plans`}</span>
    </div>
    ${progressHtml}
  `;

  card.addEventListener('click', () => openDetail(task));
  return card;
}

function renderAgentOptions(selected) {
  const options = ['<option value="">Select an agent</option>'];
  for (const agent of availableAgents) {
    options.push(`<option value="${esc(agent.id)}"${agent.id === selected ? ' selected' : ''}>${esc(agent.label)}</option>`);
  }
  return options.join('');
}

function renderExecutionContext(executionContext) {
  if (!executionContext?.branchName) {
    return '';
  }

  const repoLines = (executionContext.repos || [])
    .map((repo) => `<div class="execution-line"><span>${esc(repo.repoName)}</span><code>${esc(repo.worktreePath)}</code></div>`)
    .join('');

  return `
    <div class="detail-section">
      <div class="detail-section-label">Execution Context</div>
      <div class="execution-line"><span>Branch</span><code>${esc(executionContext.branchName)}</code></div>
      ${repoLines}
    </div>
  `;
}

function getAgentConfig(agentId) {
  return availableAgents.find((a) => a.id === agentId) || {};
}

function getModelCatalog(agentId) {
  return getAgentConfig(agentId).modelCatalog || [];
}

function getModelOptionsForAgent(agentId) {
  const catalog = getModelCatalog(agentId);
  if (catalog.length > 0) {
    return catalog.map((entry) => ({
      value: entry.slug,
      label: entry.label || entry.slug,
    }));
  }

  return (getAgentConfig(agentId).models || []).map((model) => ({
    value: model,
    label: model,
  }));
}

function isValidModelForAgent(agentId, model) {
  if (!model) {
    return true;
  }
  return getModelOptionsForAgent(agentId).some((option) => option.value === model);
}

function isValidEffortForSelection(agentId, model, effort) {
  if (!effort) {
    return true;
  }
  return getEffortsForSelection(agentId, model).includes(effort);
}

function normalizePhaseUiSelection(selection = {}) {
  const agentId = selection.agentId || '';
  const model = isValidModelForAgent(agentId, selection.model || '') ? (selection.model || '') : '';
  const effort = isValidEffortForSelection(agentId, model, selection.effort || '') ? (selection.effort || '') : '';
  return { agentId, model, effort };
}

async function readApiError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object') {
      return payload;
    }
  } catch {
    // fall through
  }

  try {
    const text = await response.text();
    return { error: text || `HTTP ${response.status}` };
  } catch {
    return { error: `HTTP ${response.status}` };
  }
}

function getPhaseValidation(runtime = {}) {
  const base = runtime.phaseValidation || {};
  const merged = {};
  for (const phase of TIMELINE_PHASES) {
    merged[phase.key] = transientPhaseValidation[phase.key] || base[phase.key] || null;
  }
  return merged;
}

function hasPhaseValidationErrors(runtime = {}) {
  const validation = getPhaseValidation(runtime);
  return Object.values(validation).some(Boolean);
}

function clearTransientPhaseValidation(phaseKey = null) {
  if (!phaseKey) {
    transientPhaseValidation = {};
    return;
  }
  const next = { ...transientPhaseValidation };
  delete next[phaseKey];
  transientPhaseValidation = next;
}

function setTransientPhaseValidation(issue) {
  if (!issue?.phase) {
    return;
  }
  transientPhaseValidation = {
    ...transientPhaseValidation,
    [issue.phase]: issue,
  };
  if (currentTask) {
    renderInteractionHeader(currentTask);
  }
}

function renderModelOptions(agentId, selected) {
  const models = getModelOptionsForAgent(agentId);
  if (models.length === 0) return '<option value="">Default</option>';
  const opts = ['<option value="">Default model</option>'];
  for (const option of models) {
    opts.push(`<option value="${esc(option.value)}" ${option.value === selected ? 'selected' : ''}>${esc(option.label)}</option>`);
  }
  return opts.join('');
}

function getEffortsForSelection(agentId, model) {
  const catalog = getModelCatalog(agentId);
  if (catalog.length > 0 && model) {
    const entry = catalog.find((item) => item.slug === model);
    if (entry?.efforts?.length) {
      return entry.efforts;
    }
  }
  return getAgentConfig(agentId).efforts || [];
}

function renderEffortOptions(agentId, model, selected) {
  const efforts = getEffortsForSelection(agentId, model);
  if (efforts.length === 0) return '<option value="">Default</option>';
  const opts = ['<option value="">Default effort</option>'];
  for (const e of efforts) {
    opts.push(`<option value="${esc(e)}" ${e === selected ? 'selected' : ''}>${esc(e)}</option>`);
  }
  return opts.join('');
}

function shouldShowEffort(agentId, model) {
  return getEffortsForSelection(agentId, model).length > 0;
}

function syncPhaseSelectControls(agentSelect, modelSelect, effortSelect, effortField, nextSelection = {}) {
  const normalized = normalizePhaseUiSelection({
    agentId: nextSelection.agentId !== undefined ? nextSelection.agentId : (agentSelect?.value || ''),
    model: nextSelection.model !== undefined ? nextSelection.model : (modelSelect?.value || ''),
    effort: nextSelection.effort !== undefined ? nextSelection.effort : (effortSelect?.value || ''),
  });

  if (agentSelect) {
    agentSelect.value = normalized.agentId;
  }

  if (modelSelect) {
    modelSelect.innerHTML = renderModelOptions(normalized.agentId, normalized.model);
    modelSelect.disabled = !normalized.agentId;
    modelSelect.value = normalized.model;
  }

  const showEffort = shouldShowEffort(normalized.agentId, normalized.model);
  if (effortSelect) {
    effortSelect.innerHTML = renderEffortOptions(normalized.agentId, normalized.model, normalized.effort);
    effortSelect.disabled = !normalized.agentId || !showEffort;
    effortSelect.value = showEffort ? normalized.effort : '';
  }

  if (effortField) {
    effortField.classList.toggle('hidden', !showEffort);
  }

  return {
    agentId: normalized.agentId,
    model: normalized.model,
    effort: showEffort ? normalized.effort : '',
  };
}

async function savePhaseAssignment(task, phaseKey, selection) {
  const response = await fetch(`/api/tasks/${task.boardColumn}/${task.filename}/assignment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phase: phaseKey,
      agentId: selection.agentId,
      model: selection.model,
      effort: selection.effort,
    }),
  });
  if (!response.ok) {
    const issue = await readApiError(response);
    const error = new Error(issue.error || 'Failed to save phase configuration');
    error.issue = issue;
    throw error;
  }
}

function hasCompletePhaseAssignments(runtime) {
  return TIMELINE_PHASES.every((phase) => Boolean(getPhaseSelection(runtime, phase.key).agentId));
}

const STEP_ACCENTS = [
  { gradient: 'linear-gradient(135deg, #005ecb, #3b82f6)', bg: 'rgba(0, 94, 203, 0.04)', border: 'rgba(0, 94, 203, 0.18)' },
  { gradient: 'linear-gradient(135deg, #6d28d9, #8b5cf6)', bg: 'rgba(109, 40, 217, 0.04)', border: 'rgba(109, 40, 217, 0.18)' },
  { gradient: 'linear-gradient(135deg, #0b7f4f, #10b981)', bg: 'rgba(11, 127, 79, 0.04)', border: 'rgba(11, 127, 79, 0.18)' },
];

function renderAgentBar(task) {
  // Agent bar is intentionally empty — all content moved to the Activity section
  agentBar.innerHTML = '';
}

function renderTaskDetail(task, options = {}) {
  const status = task.status || 'to_start';
  const runtime = task.runtime || {};
  const run = runtime.run;
  const branches = (task.branch_name || []).length
    ? `
      <div class="detail-section">
        <div class="detail-section-label">Branches</div>
        <p>${task.branch_name.map((branch) => `<code>${esc(branch)}</code>`).join(', ')}</p>
      </div>
    `
    : '';

  const labelButtons = LABEL_OPTIONS
    .map((label) => {
      const active = (task.labels || []).includes(label);
      return `<button class="label-toggle label-${label}${active ? ' label-toggle-active' : ''}" data-label="${label}">${label}</button>`;
    })
    .join('');

  const repos = (task.repository || [])
    .map((repo) => `<span class="badge repo-pill">${esc(repo)}</span>`)
    .join('');

  const progressHtml = task.todoTotal > 0
    ? `
      <div class="detail-section">
        <div class="detail-section-label">Progress</div>
        <div class="progress-wrapper progress-wrapper-detail">
          <div class="progress-bar progress-bar-detail"><div class="progress-fill" style="width: ${Math.round((task.todoDone / task.todoTotal) * 100)}%"></div></div>
          <span class="progress-label">${task.todoDone}/${task.todoTotal} items done</span>
        </div>
      </div>
    `
    : '';

  taskContent.innerHTML = `
    <div class="editable-field" data-field="title">
      <div class="editable-display detail-title">${esc(task.title)}</div>
      <input class="editable-input editable-input-title hidden" type="text" value="${esc(task.title || '')}">
    </div>
    <div class="detail-badges">
      <span class="badge badge-${status}">${STATUS_LABELS[status] || status}</span>
      ${renderLabels(task.labels)}
      ${repos}
    </div>
    <div class="detail-meta">
      <span>Created: ${esc(task.creation_date || 'N/A')}</span>
      <span>Started: ${task.start_date ? esc(task.start_date) : 'Not started'}</span>
      ${run ? `<span>Run: ${esc(formatTimestamp(run.updatedAt))}</span>` : ''}
    </div>
    <div class="detail-section detail-section-labels">
      <div class="detail-section-label">Assign Labels</div>
      <div class="label-toggles">${labelButtons}</div>
    </div>
    <div class="detail-section">
      <div class="detail-section-label">Description</div>
      <div class="editable-field" data-field="short_description">
        <div class="editable-display"><p>${esc(task.short_description || '')}</p></div>
        <textarea class="editable-input editable-input-area hidden">${esc(task.short_description || '')}</textarea>
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-section-label">Main Goal</div>
      <div class="editable-field" data-field="main_goal">
        <div class="editable-display"><p>${esc(task.main_goal || '')}</p></div>
        <textarea class="editable-input editable-input-area hidden">${esc(task.main_goal || '')}</textarea>
      </div>
    </div>
    ${branches}
    ${renderExecutionContext(runtime.executionContext)}
    ${progressHtml}
    <div class="detail-section">
      <div class="detail-section-label">Body</div>
      <div class="editable-field" data-field="body">
        <div class="editable-display">${task.bodyHtml || '<p class="editable-placeholder">Click to add content...</p>'}</div>
        <textarea class="editable-input editable-input-area editable-input-body hidden">${esc(task.body || '')}</textarea>
      </div>
    </div>
  `;

  renderAgentBar(task);
  if (!options.preservePlanPanel) {
    renderPlanPanel(task);
  }
  bindTaskDetailEvents(task);
}

const TIMELINE_PHASES = [
  { key: 'planning', label: 'Agent Plan' },
  { key: 'implementing', label: 'Implementing' },
  { key: 'validate', label: 'Validate' },
];

function phaseIndex(phaseKey) {
  const idx = TIMELINE_PHASES.findIndex((p) => p.key === phaseKey);
  return idx;
}

function renderTimeline(run, runtime, isDoing) {
  const current = run ? phaseIndex(run.phase) : -1;
  const isRunning = run && ['running', 'queued', 'awaiting_input'].includes(run.status);
  const isCompleted = run?.status === 'completed';
  const isFailed = run?.status === 'failed';
  const isStopped = run && ['stopped', 'interrupted', 'stopping'].includes(run.status);
  const phaseValidation = runtime ? getPhaseValidation(runtime) : {};

  return `
    <div class="phase-timeline">
      ${TIMELINE_PHASES.map((phase, i) => {
        let state = 'pending';
        if (isCompleted || current > i) {
          state = 'done';
        } else if (current === i && isRunning) {
          state = 'active';
        } else if (current === i && isFailed) {
          state = 'failed';
        } else if (current === i && isStopped) {
          state = 'stopped';
        }

        let iconHtml;
        if (state === 'active') {
          iconHtml = '<span class="phase-icon phase-icon-spinning"></span>';
        } else if (state === 'done') {
          iconHtml = '<span class="phase-icon phase-icon-done">&#10003;</span>';
        } else if (state === 'failed') {
          iconHtml = '<span class="phase-icon phase-icon-failed">&#10007;</span>';
        } else if (state === 'stopped') {
          iconHtml = '<span class="phase-icon phase-icon-stopped">&#9632;</span>';
        } else {
          iconHtml = '<span class="phase-icon phase-icon-pending">&#9675;</span>';
        }

        // Config text under each step
        let configHtml = '';
        if (isDoing && runtime) {
          const sel = getPhaseSelection(runtime, phase.key);
          const issue = phaseValidation[phase.key];
          const parts = [
            sel.agentId ? agentLabel(sel.agentId) : null,
            sel.model || null,
            sel.effort || null,
          ].filter(Boolean);
          configHtml = parts.length > 0
            ? `<span class="phase-step-config${issue ? ' phase-step-config-invalid' : ''}" data-phase-config="${phase.key}">${esc(parts.join(' · '))}</span>${issue ? `<span class="phase-step-error">${esc(issue.error)}</span>` : ''}`
            : `<span class="phase-step-config phase-step-config-empty${issue ? ' phase-step-config-invalid' : ''}" data-phase-config="${phase.key}">configure</span>${issue ? `<span class="phase-step-error">${esc(issue.error)}</span>` : ''}`;
        }

        return `
          <div class="phase-step phase-step-${state}">
            ${iconHtml}
            <span class="phase-step-label">${phase.label}</span>
            ${configHtml}
          </div>
          ${i < TIMELINE_PHASES.length - 1 ? '<div class="phase-connector' + (current > i || isCompleted ? ' phase-connector-done' : '') + '"></div>' : ''}
        `;
      }).join('')}
    </div>
  `;
}

function renderInteractionHeader(task) {
  const runtime = task.runtime || {};
  const run = currentRunMeta || runtime.run;
  const isDoing = task.storageColumn === 'doing' && task.boardColumn === 'doing';
  const hasActiveRun = Boolean(runtime.activeRunId && run && ['queued', 'running', 'stopping', 'awaiting_input'].includes(run.status));
  const phaseValidation = getPhaseValidation(runtime);
  const hasErrors = Object.values(phaseValidation).some(Boolean);
  const planApproved = runtime.planState === 'approved';
  const pipelineReady = planApproved && hasCompletePhaseAssignments(runtime) && !hasErrors;
  const resumableRun = Boolean(run && ['stopped', 'interrupted', 'failed'].includes(run.status));
  const canRestart = pipelineReady && currentInteractionTab === 'transcript' && !hasActiveRun && Boolean(run);
  const startLabel = resumableRun || run?.pendingInputRequest ? 'Resume' : 'Start';

  const subtitle = hasErrors
    ? `Fix the phase configuration errors shown in the timeline below before ${resumableRun ? 'resuming' : 'starting'}.`
    : !planApproved && isDoing
      ? 'Approve the implementation plan before starting the pipeline.'
    : run
      ? `${formatRunStatus(run.status)}${run.waitingForInput ? ' • answer below to continue' : ''}`
      : 'Click the phase text below each step to configure agent, model, and effort.';

  const actionsHtml = isDoing
    ? `
      <div class="header-actions">
        <button class="ab-btn ab-btn-start" id="agent-start" ${pipelineReady ? '' : 'disabled'} ${hasActiveRun ? 'disabled' : ''}>${startLabel}</button>
        ${canRestart ? '<button class="ab-btn ab-btn-restart" id="agent-restart">Restart</button>' : ''}
        <button class="ab-btn ab-btn-stop" id="agent-stop" ${hasActiveRun ? '' : 'disabled'}>Stop</button>
      </div>
    `
    : '';

  interactionHeader.innerHTML = `
    <div class="interaction-header-top">
      <div>
        <div class="detail-section-label">Agent</div>
        <div class="interaction-subtitle">${esc(subtitle)}</div>
      </div>
      <div class="interaction-header-right">
        <div class="interaction-badges">
          ${runChip(run)}
          ${waitingChip(run)}
        </div>
        ${actionsHtml}
      </div>
    </div>
    ${isDoing && hasErrors ? '<div class="icfg-summary-error">One or more phase selections are invalid.</div>' : ''}
  `;
}

function bindTaskDetailEvents(task) {
  taskContent.querySelectorAll('.label-toggle').forEach((button) => {
    button.addEventListener('click', async () => {
      const label = button.dataset.label;
      const current = task.labels || [];
      const labels = current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label];

      try {
        const response = await fetch(`/api/tasks/${task.boardColumn}/${task.filename}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels }),
        });
        if (!response.ok) {
          throw new Error('label update failed');
        }
        await refreshCurrentTask(true);
      } catch (error) {
        console.error('Label update failed:', error);
      }
    });
  });

  bindEditableFields(task);

}

function bindEditableFields(task) {
  taskContent.querySelectorAll('.editable-field').forEach((field) => {
    const display = field.querySelector('.editable-display');
    const input = field.querySelector('.editable-input');
    const fieldName = field.dataset.field;
    const previousValue = fieldName === 'body' ? (task.body || '') : (task[fieldName] || '');

    display.addEventListener('click', () => {
      display.classList.add('hidden');
      input.classList.remove('hidden');
      input.focus();
      if (input.tagName === 'TEXTAREA') {
        input.style.height = 'auto';
        input.style.height = `${Math.max(80, input.scrollHeight)}px`;
      }
    });

    const saveField = async () => {
      const nextValue = input.value;
      display.classList.remove('hidden');
      input.classList.add('hidden');
      if (nextValue === previousValue) {
        return;
      }

      try {
        const payload = fieldName === 'body'
          ? { fields: {}, body: nextValue }
          : { fields: { [fieldName]: nextValue }, body: task.body || '' };

        const response = await fetch(`/api/tasks/${task.boardColumn}/${task.filename}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error('update failed');
        }
        await refreshCurrentTask(true);
      } catch (error) {
        console.error('Save failed:', error);
      }
    };

    input.addEventListener('blur', saveField);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        input.value = previousValue;
        display.classList.remove('hidden');
        input.classList.add('hidden');
      }
      if (input.tagName === 'INPUT' && event.key === 'Enter') {
        event.preventDefault();
        saveField();
      }
    });
  });
}

function resetInteractionPanel() {
  disconnectRunSocket();
  disconnectDraftSocket();
  stopPhaseTimer();
  destroyTerminal();
  currentRunId = null;
  currentRunMeta = null;
  currentRunEvents = [];
  currentRawLog = '';
  cachedManualTestInstructions = null;
  manualTestRunId = null;
  currentPlanPath = null;
  currentPlanRaw = '';
  currentPlanDirty = false;
  interactionPlan.innerHTML = '<div class="interaction-empty">Open a task to inspect or draft its plan.</div>';
  interactionTranscript.innerHTML = '<div class="interaction-empty">No run started for this task yet.</div>';
  interactionRawContent.textContent = '';
  interactionInput.classList.add('hidden');
  interactionInput.innerHTML = '';
}

function initTerminal(cwd) {
  const taskId = currentTask?.filename || currentTask?.runtime?.taskId;
  if (!taskId) {
    return;
  }
  if (activeTerm && activeTerminalTaskId === taskId) {
    if (activeTermResizeObserver) {
      requestAnimationFrame(() => {
        if (activeTermWs?.readyState === WebSocket.OPEN) {
          const fitAddon = activeTerm._fitAddon;
          if (fitAddon) {
            fitAddon.fit();
            activeTermWs.send(`\x01resize:${activeTerm.cols},${activeTerm.rows}`);
          }
        }
      });
    }
    return;
  }

  destroyTerminal();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const cwdParam = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const wsUrl = `${protocol}//${window.location.host}/ws/tasks/${encodeURIComponent(taskId)}/terminal${cwdParam}`;

  const term = new window.Terminal({
    fontFamily: "'JetBrainsMono NF', monospace",
    fontSize: 13,
    theme: {
      background: '#0f1824',
      foreground: '#d6deeb',
      cursor: '#80a4c2',
      selectionBackground: 'rgba(128, 164, 194, 0.3)',
    },
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(interactionTerminal);
  fitAddon.fit();

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(`\x01resize:${term.cols},${term.rows}`);
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
    term.write(data);
  };

  ws.onclose = () => {
    term.write('\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n');
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(`\x01resize:${term.cols},${term.rows}`);
    }
  });
  resizeObserver.observe(interactionTerminal);

  activeTerm = term;
  activeTerm._fitAddon = fitAddon;
  activeTermWs = ws;
  activeTermResizeObserver = resizeObserver;
  activeTerminalTaskId = taskId;
}

function destroyTerminal() {
  if (activeTermResizeObserver) {
    activeTermResizeObserver.disconnect();
    activeTermResizeObserver = null;
  }
  if (activeTermWs) {
    try { activeTermWs.close(); } catch { /* ignore */ }
    activeTermWs = null;
  }
  if (activeTerm) {
    activeTerm.dispose();
    activeTerm = null;
  }
  activeTerminalTaskId = null;
  interactionTerminal.innerHTML = '';
}

function disconnectRunSocket() {
  if (activeRunSocket) {
    try {
      activeRunSocket.close();
    } catch {
      // ignore
    }
    activeRunSocket = null;
  }
}

function isCurrentPlanApproved() {
  return currentTask?.runtime?.planState === 'approved';
}

function syncInteractionTabLocks() {
  const locked = currentTask && !isCurrentPlanApproved();
  for (const button of [transcriptTabButton, terminalTabButton, rawTabButton]) {
    button.disabled = Boolean(locked);
    button.setAttribute('aria-disabled', locked ? 'true' : 'false');
    button.title = locked ? 'Approve the plan before using agent tabs.' : '';
    button.classList.toggle('interaction-tab-disabled', Boolean(locked));
  }
  planTabButton.disabled = false;
  planTabButton.setAttribute('aria-disabled', 'false');
  planTabButton.title = '';

  if (locked && currentInteractionTab !== 'plan') {
    currentInteractionTab = 'plan';
  }
}

async function switchInteractionTab(tab) {
  syncInteractionTabLocks();
  if (tab !== 'plan' && currentTask && !isCurrentPlanApproved()) {
    tab = 'plan';
  }
  if (tab !== 'plan' && !(await autosaveCurrentPlan())) {
    return;
  }
  currentInteractionTab = tab;
  syncInteractionTabLocks();
  planTabButton.classList.toggle('interaction-tab-active', tab === 'plan');
  transcriptTabButton.classList.toggle('interaction-tab-active', tab === 'transcript');
  terminalTabButton.classList.toggle('interaction-tab-active', tab === 'terminal');
  rawTabButton.classList.toggle('interaction-tab-active', tab === 'raw');
  interactionPlan.classList.toggle('hidden', tab !== 'plan');
  interactionTranscript.classList.toggle('hidden', tab !== 'transcript');
  interactionTerminal.classList.toggle('hidden', tab !== 'terminal');
  interactionRaw.classList.toggle('hidden', tab !== 'raw');

  if (tab === 'plan') {
    renderPlanPanel(currentTask);
  }
  if (currentTask) {
    renderInteractionHeader(currentTask);
  }

  if (tab === 'terminal') {
    const cwd = currentRunMeta?.executionContext?.primaryWorktreePath || '';
    initTerminal(cwd);
  }

  if (tab === 'raw' && currentRunId) {
    loadRawLog(currentRunId).catch((error) => console.error('Raw log load failed:', error));
  }
}

function formatAgentStatus(event) {
  const marker = event.marker.replace(/^MOIRAI_/, '').replace(/_/g, ' ').toLowerCase();
  return `${marker}: ${event.value}`;
}

function groupTranscriptEvents(events) {
  const cleaned = [];
  let seenMeaningfulAgentEvent = false;

  for (const event of events) {
    if (event.type === 'phase') {
      seenMeaningfulAgentEvent = false;
      cleaned.push(event);
      continue;
    }

    if (
      !seenMeaningfulAgentEvent
      && ['agent_output', 'agent_error_output'].includes(event.type)
    ) {
      continue;
    }

    if (
      !seenMeaningfulAgentEvent
      && event.type === 'error'
      && event.message === 'input request payload has invalid kind'
    ) {
      continue;
    }

    if (['agent_note', 'agent_action', 'agent_section', 'input_request', 'agent_status'].includes(event.type)) {
      seenMeaningfulAgentEvent = true;
    }

    cleaned.push(event);
  }

  const grouped = [];

  for (const event of cleaned) {
    const previous = grouped[grouped.length - 1];
    const mergeable = ['agent_output', 'agent_error_output', 'system_output'];
    if (
      previous
      && mergeable.includes(event.type)
      && previous.type === event.type
      && previous.phase === event.phase
    ) {
      previous.message = `${previous.message}\n${event.message}`;
      previous.timestamp = event.timestamp;
      continue;
    }

    grouped.push({ ...event });
  }

  // Merge success/error results into their preceding command
  const merged = [];
  for (const event of grouped) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.type === 'command'
      && (event.type === 'success' || event.type === 'error')
    ) {
      previous.result = { type: event.type, message: event.message };
      previous.timestamp = event.timestamp;
      continue;
    }
    merged.push(event);
  }

  return merged;
}

function simplifyCommand(raw) {
  // Agent launch command
  if (/^codex\s+exec\b/.test(raw) || /^claude\s/.test(raw) || /^opencode\s/.test(raw)) {
    return { summary: 'Agent started', full: raw };
  }

  // Shell wrapper: /bin/zsh -lc "actual command" in /working/dir
  const shellMatch = raw.match(/^\/bin\/(?:ba|z)?sh\s+-lc\s+"(.+)"\s+in\s+(.+)$/s);
  if (shellMatch) {
    const inner = shellMatch[1];

    // sed read: sed -n '1,220p' path/file
    const sedMatch = inner.match(/^sed\s+-n\s+'[\d,]+p'\s+(.+)$/);
    if (sedMatch) {
      const file = sedMatch[1].split('/').pop();
      return { summary: `Read ${file}`, full: raw };
    }

    // cat
    const catMatch = inner.match(/^cat\s+(.+)$/);
    if (catMatch) {
      const file = catMatch[1].split('/').pop();
      return { summary: `Read ${file}`, full: raw };
    }

    // rg / grep / git grep
    if (/^(rg|grep|git\s+grep)\b/.test(inner)) {
      return { summary: 'Search files', full: raw };
    }

    // ls / find / tree
    if (/^(pwd|ls|find|tree)\b/.test(inner)) {
      return { summary: 'Explore directory', full: raw };
    }

    // git commands
    if (/^git\b/.test(inner)) {
      const gitCmd = inner.match(/^git\s+(\S+)/);
      return { summary: `git ${gitCmd ? gitCmd[1] : ''}`, full: raw };
    }

    // Combined commands with && or | -- show truncated
    const truncated = inner.length > 90 ? inner.slice(0, 87) + '...' : inner;
    return { summary: truncated, full: raw };
  }

  // Bare command fallback
  const truncated = raw.length > 90 ? raw.slice(0, 87) + '...' : raw;
  return { summary: truncated, full: raw };
}

function renderTranscriptEvent(event) {
  // Phase dividers
  if (event.type === 'phase') {
    return `
      <div class="transcript-phase">
        <span>${esc(event.message)}</span>
      </div>
    `;
  }

  // Section dividers (agent_section)
  if (event.type === 'agent_section') {
    const sectionLabels = SECTION_LABELS;
    const label = sectionLabels[event.section] || event.section;
    return `
      <div class="transcript-section-divider">
        <span>${esc(label)}</span>
      </div>
    `;
  }

  // System messages -- compact single line
  if (event.type === 'system') {
    return `
      <div class="transcript-system-line">
        <span class="transcript-system-icon">&#9679;</span>
        <span class="transcript-system-msg">${esc(event.message)}</span>
        <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
      </div>
    `;
  }

  // Standalone success/error (when not merged into a command)
  if (event.type === 'success' || event.type === 'error') {
    const icon = event.type === 'success' ? '&#10003;' : '&#10007;';
    return `
      <div class="transcript-system-line transcript-result-${event.type}">
        <span class="transcript-system-icon">${icon}</span>
        <span class="transcript-system-msg">${esc(event.message)}</span>
        <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
      </div>
    `;
  }

  // Commands -- simplified summary with optional merged result
  if (event.type === 'command') {
    const cmd = simplifyCommand(event.message);
    const resultHtml = event.result
      ? `<span class="transcript-cmd-result transcript-cmd-result-${event.result.type}">${event.result.type === 'success' ? '&#10003; OK' : '&#10007; Failed'}</span>`
      : '';
    return `
      <article class="transcript-item transcript-item-command">
        <div class="transcript-cmd">
          <div class="transcript-cmd-summary">
            <span>${esc(cmd.summary)}</span>
            ${resultHtml}
          </div>
          ${cmd.summary !== cmd.full ? `
            <details class="transcript-cmd-details">
              <summary>Full command</summary>
              <pre class="transcript-pre">${esc(cmd.full)}</pre>
            </details>
          ` : ''}
        </div>
      </article>
    `;
  }

  // Agent note -- prominent card with prose
  if (event.type === 'agent_note') {
    return `
      <article class="transcript-item transcript-item-note">
        <div class="transcript-meta">
          <span class="transcript-label">Agent Note</span>
          <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
        </div>
        <div class="transcript-body"><p>${esc(event.message)}</p></div>
      </article>
    `;
  }

  // Agent action -- visible action description
  if (event.type === 'agent_action') {
    return `
      <article class="transcript-item transcript-item-action">
        <div class="transcript-meta">
          <span class="transcript-label">Agent Action</span>
          <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
        </div>
        <div class="transcript-body"><p>${esc(event.message)}</p></div>
      </article>
    `;
  }

  // Agent status
  if (event.type === 'agent_status') {
    return `
      <article class="transcript-item transcript-item-status">
        <div class="transcript-meta">
          <span class="transcript-label">Status</span>
          <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
        </div>
        <div class="transcript-body"><p>${esc(formatAgentStatus(event))}</p></div>
      </article>
    `;
  }

  // Input request
  if (event.type === 'input_request') {
    const choices = event.request.choices?.length
      ? `<div class="transcript-choices">${event.request.choices.map((choice) => `<span class="transcript-choice">${esc(choice)}</span>`).join('')}</div>`
      : '';
    return `
      <article class="transcript-item transcript-item-input-request">
        <div class="transcript-meta">
          <span class="transcript-label">Needs Input</span>
          <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
        </div>
        <div class="transcript-body">
          <p>${esc(event.request.prompt)}</p>
          ${choices}
        </div>
      </article>
    `;
  }

  // Input response
  if (event.type === 'input_response') {
    return `
      <article class="transcript-item transcript-item-input-response">
        <div class="transcript-meta">
          <span class="transcript-label">You Replied</span>
          <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
        </div>
        <pre class="transcript-pre">${esc(event.answer)}</pre>
      </article>
    `;
  }

  // Fallback for agent_output, agent_error_output, system_output, and unknown types
  const labelMap = {
    agent_output: 'Agent',
    agent_error_output: 'Agent Error',
    system_output: 'Command Output',
    plan_file_updated: 'Plan Updated',
    tests_started: 'Tests',
    tests_finished: 'Tests',
    docs_updated: 'Docs',
    manual_test_instructions_ready: 'Manual QA',
    review_feedback: 'Reviewer Feedback',
    review_decision: 'Review Decision',
    iteration_started: 'Iteration',
  };
  const classMap = {
    agent_output: 'transcript-item-output',
    agent_error_output: 'transcript-item-error-output',
    system_output: 'transcript-item-command-output',
    plan_file_updated: 'transcript-item-note',
    tests_started: 'transcript-item-action',
    tests_finished: 'transcript-item-success',
    docs_updated: 'transcript-item-note',
    manual_test_instructions_ready: 'transcript-item-success',
    review_feedback: 'transcript-item-error',
    review_decision: 'transcript-item-note',
    iteration_started: 'transcript-item-action',
  };
  const label = labelMap[event.type] || event.type;
  const cls = classMap[event.type] || 'transcript-item-output';
  let body = '';
  if (event.message) {
    body = `<pre class="transcript-pre">${esc(event.message)}</pre>`;
  } else if (event.raw) {
    body = `<pre class="transcript-pre">${esc(event.raw)}</pre>`;
  }
  return `
    <article class="transcript-item ${cls}">
      <div class="transcript-meta">
        <span class="transcript-label">${label}</span>
        <span class="transcript-time">${esc(formatTimestamp(event.timestamp))}</span>
      </div>
      ${body}
    </article>
  `;
}

function getLatestOutput(events) {
  const recent = [];
  const maxItems = 150;
  for (let i = events.length - 1; i >= 0 && recent.length < maxItems; i--) {
    const e = events[i];
    if (['success', 'agent_error_output', 'phase'].includes(e.type)) continue;
    if (e.type === 'system' && /^\[planning\]/.test(e.message)) continue;
    recent.push(e);
  }
  return recent;
}

const PHASE_DISPLAY = {
  phase_0: 'Bootstrap',
  phase_1: 'Agent Plan',
  phase_2: 'Implementing',
  phase_3: 'Validating',
  phase_4: 'Review',
  planning: 'Agent Plan',
  implementing: 'Implementing',
  validate: 'Validating',
  review: 'Review',
  docs: 'Docs',
  ...SECTION_LABELS,
};

function resolvePhaseName(phase, event) {
  if (event?.type === 'phase' && event.message) return event.message;
  return PHASE_DISPLAY[phase] || phase || 'Unknown';
}

function resolveGroupRunner(event) {
  const runner = formatEventRunner(event);
  if (runner) return runner;
  // Fallback to task-level assignment
  const agent = currentTask?.runtime?.assignedAgent;
  if (agent) return agentLabel(agent);
  return '';
}

function groupFeedEvents(events) {
  if (events.length === 0) return [];

  const groups = [];
  let current = null;

  for (const event of events) {
    const phase = event.phase || '';
    const runner = resolveGroupRunner(event);
    const ts = new Date(event.timestamp).getTime();

    const sameGroup = current
      && current.phase === phase
      && current.runner === runner
      && Math.abs(ts - current.lastTs) < 10000;

    if (sameGroup) {
      current.events.push(event);
      current.lastTs = ts;
    } else {
      current = {
        phase,
        runner,
        phaseLabel: resolvePhaseName(phase, event),
        firstTs: ts,
        lastTs: ts,
        events: [event],
      };
      groups.push(current);
    }
  }

  return groups;
}

function latestEventIcon(event) {
  switch (event.type) {
    case 'phase': return '<span class="feed-icon feed-icon-phase">&#9674;</span>';
    case 'agent_note': return '<span class="feed-icon feed-icon-note">&#9679;</span>';
    case 'agent_action': return '<span class="feed-icon feed-icon-action">&#9654;</span>';
    case 'command': {
      if (event.result?.type === 'error') return '<span class="feed-icon feed-icon-error">&#10007;</span>';
      if (event.result?.type === 'success') return '<span class="feed-icon feed-icon-ok">&#10003;</span>';
      return '<span class="feed-icon feed-icon-cmd">$</span>';
    }
    case 'agent_status': return '<span class="feed-icon feed-icon-status">&#9670;</span>';
    case 'agent_section': return '<span class="feed-icon feed-icon-section">&#9472;</span>';
    case 'input_request': return '<span class="feed-icon feed-icon-input">?</span>';
    case 'system': return '<span class="feed-icon feed-icon-system">&#8226;</span>';
    default: return '<span class="feed-icon feed-icon-system">&#8226;</span>';
  }
}

function resolveEventRunner(event) {
  if (event?.runner?.agentId) {
    return event.runner;
  }

  const phaseKey = event?.phase;
  if (!phaseKey) {
    return null;
  }

  const selection = currentTask?.runtime?.phaseConfig?.[phaseKey] || null;
  if (!selection?.agentId) {
    return null;
  }

  return {
    agentId: selection.agentId,
    model: selection.model || null,
    effort: selection.effort || null,
  };
}

function formatEventRunner(event) {
  const runner = resolveEventRunner(event);
  if (!runner?.agentId) {
    return '';
  }

  const parts = [agentLabel(runner.agentId)];
  if (runner.model) {
    parts.push(modelLabel(runner.agentId, runner.model));
  }
  if (runner.effort) {
    parts.push(runner.effort);
  }
  return parts.join(' • ');
}

function renderLatestRunner(event) {
  const summary = formatEventRunner(event);
  if (!summary) {
    return '';
  }
  return `<div class="feed-runner">${esc(summary)}</div>`;
}

function collapseFeedCommands(events) {
  const result = [];
  let cmdRun = [];

  function flushCmds() {
    if (cmdRun.length >= 3) {
      result.push({ type: 'command_group', commands: cmdRun, timestamp: cmdRun[cmdRun.length - 1].timestamp });
    } else {
      result.push(...cmdRun);
    }
    cmdRun = [];
  }

  for (const event of events) {
    if (event.type === 'command') {
      cmdRun.push(event);
    } else {
      flushCmds();
      result.push(event);
    }
  }
  flushCmds();
  return result;
}

function renderLatestEvent(event) {
  const icon = latestEventIcon(event);
  const time = formatTimestamp(event.timestamp);
  const shortTime = time.split(', ').pop() || time;

  if (event.type === 'command_group') {
    const cmds = event.commands;
    const previews = cmds.slice(0, 2).map((c) => simplifyCommand(c.message).summary);
    const summary = `${cmds.length} commands \u2014 ${previews.join(', ')}${cmds.length > 2 ? ', ...' : ''}`;
    const innerHtml = cmds.map((c) => {
      const cmd = simplifyCommand(c.message);
      const badge = c.result
        ? `<span class="feed-cmd-result feed-cmd-result-${c.result.type}">${c.result.type === 'success' ? '&#10003;' : '&#10007;'}</span>`
        : '';
      return `<div class="feed-row feed-row-cmd"><div class="feed-body"><code class="feed-code">${esc(cmd.summary)}${badge}</code></div></div>`;
    }).join('');
    return `
      <details class="feed-cmd-group">
        <summary class="feed-row feed-row-cmd">
          <span class="feed-icon feed-icon-cmd">$</span>
          <div class="feed-body"><code class="feed-code">${esc(summary)}</code></div>
          <span class="feed-time">${esc(shortTime)}</span>
        </summary>
        <div class="feed-cmd-group-list">${innerHtml}</div>
      </details>
    `;
  }

  if (event.type === 'phase') {
    return `
      <div class="feed-row feed-row-phase">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-phase">${esc(event.message || SECTION_LABELS[event.phaseKey] || event.phaseKey || 'Phase')}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'agent_note') {
    return `
      <div class="feed-row feed-row-note">
        ${icon}
        <div class="feed-body">
          <p class="feed-text">${esc(event.message)}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'agent_action') {
    return `
      <div class="feed-row feed-row-action">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-secondary">${esc(event.message)}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'command') {
    const cmd = simplifyCommand(event.message);
    const resultBadge = event.result
      ? `<span class="feed-cmd-result feed-cmd-result-${event.result.type}">${event.result.type === 'success' ? '&#10003;' : '&#10007;'}</span>`
      : '';
    return `
      <div class="feed-row feed-row-cmd">
        ${icon}
        <div class="feed-body">
          <code class="feed-code">${esc(cmd.summary)}${resultBadge}</code>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'agent_status') {
    return `
      <div class="feed-row feed-row-status">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-muted">${esc(formatAgentStatus(event))}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'agent_section') {
    const label = SECTION_LABELS[event.section] || event.section;
    return `
      <div class="feed-row feed-row-section">
        ${icon}
        <div class="feed-body">
          <span class="feed-section-label">${esc(label)}</span>
        </div>
      </div>
    `;
  }

  if (event.type === 'input_request') {
    return `
      <div class="feed-row feed-row-input">
        ${icon}
        <div class="feed-body">
          <p class="feed-text">${esc(event.request.prompt)}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.type === 'system') {
    return `
      <div class="feed-row feed-row-system">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-muted">${esc(event.message)}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  // Fallback for artifact events and others
  const ARTIFACT_LABELS = {
    plan_file_updated: 'Plan updated',
    tests_started: 'Tests started',
    tests_finished: 'Tests finished',
    docs_updated: 'Docs updated',
    manual_test_instructions_ready: 'Manual QA ready',
    review_feedback: 'Reviewer feedback',
    review_decision: 'Review decision',
    iteration_started: 'New iteration',
  };
  const label = ARTIFACT_LABELS[event.type];
  if (label) {
    return `
      <div class="feed-row feed-row-status">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-secondary"><strong>${esc(label)}</strong> ${esc(event.message || '')}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }

  if (event.message) {
    return `
      <div class="feed-row feed-row-system">
        ${icon}
        <div class="feed-body">
          <p class="feed-text feed-text-muted">${esc(event.message)}</p>
        </div>
        <span class="feed-time">${esc(shortTime)}</span>
      </div>
    `;
  }
  return '';
}

function renderPendingInputCard(runId, request) {
  if (!request || !runId) return '';

  let formHtml = '';
  if (request.kind === 'confirm') {
    const choices = request.choices?.length ? request.choices : ['Approve', 'Decline'];
    formHtml = `
      <div class="input-card-actions">
        ${choices.map((choice) => `<button class="input-card-choice" data-run-id="${esc(runId)}" data-request-id="${esc(request.requestId)}" data-answer="${esc(choice)}">${esc(choice)}</button>`).join('')}
      </div>
    `;
  } else if (request.kind === 'choice') {
    const choices = request.choices || [];
    formHtml = `
      <form class="input-card-form" data-run-id="${esc(runId)}" data-request-id="${esc(request.requestId)}">
        <select class="input-card-select" required>
          <option value="">Select an option…</option>
          ${choices.map((choice) => `<option value="${esc(choice)}">${esc(choice)}</option>`).join('')}
        </select>
        <button class="input-card-submit" type="submit">Send</button>
      </form>
    `;
  } else {
    formHtml = `
      <form class="input-card-form" data-run-id="${esc(runId)}" data-request-id="${esc(request.requestId)}">
        <textarea class="input-card-textarea" rows="3" required placeholder="Type your answer…"></textarea>
        <button class="input-card-submit" type="submit">Send</button>
      </form>
    `;
  }

  return `
    <div class="input-card">
      <div class="input-card-badge">Input Required</div>
      <div class="input-card-question">${esc(request.prompt)}</div>
      ${formHtml}
    </div>
  `;
}

function bindInputCardEvents() {
  interactionTranscript.querySelectorAll('.input-card-choice').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await submitRunInput(btn.dataset.runId, btn.dataset.requestId, btn.dataset.answer);
    });
  });

  interactionTranscript.querySelectorAll('.input-card-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const select = form.querySelector('.input-card-select');
      const textarea = form.querySelector('.input-card-textarea');
      const answer = select ? select.value : textarea?.value?.trim();
      if (!answer) return;
      form.querySelector('.input-card-submit').disabled = true;
      await submitRunInput(form.dataset.runId, form.dataset.requestId, answer);
    });
  });
}

function renderRunContext(run) {
  const ctx = run?.executionContext;
  if (!ctx?.branchName) return '';

  const repo = ctx.primaryRepo || 'unknown';
  const branch = ctx.branchName;
  const worktree = ctx.primaryWorktreePath || '';
  const repoRoot = ctx.repos?.[0]?.repoRoot || '';

  const browseCmd = worktree ? `cd ${worktree}` : '';
  const diffCmd = worktree ? `cd ${worktree} && git diff` : 'git diff';
  const checkoutCmd = repoRoot ? `cd ${repoRoot} && git checkout ${branch}` : `git checkout ${branch}`;

  return `
    <div class="run-context">
      <div class="run-context-row">
        <span class="run-context-key">Repo</span>
        <span class="run-context-val">${esc(repo)}</span>
      </div>
      <div class="run-context-row">
        <span class="run-context-key">Branch</span>
        <code class="run-context-code">${esc(branch)}</code>
      </div>
      <div class="run-context-commands">
        <div class="run-context-cmd-label">Terminal commands</div>
        ${browseCmd ? `<div class="run-context-cmd-row"><span class="run-context-cmd-desc">Browse code</span><code class="run-context-cmd">${esc(browseCmd)}</code></div>` : ''}
        <div class="run-context-cmd-row"><span class="run-context-cmd-desc">See changes</span><code class="run-context-cmd">${esc(diffCmd)}</code></div>
        <div class="run-context-cmd-row"><span class="run-context-cmd-desc">Checkout branch</span><code class="run-context-cmd">${esc(checkoutCmd)}</code></div>
      </div>
    </div>
  `;
}

function getPhaseStats(events, phaseKey) {
  let phaseStart = null;
  let actions = 0;
  let commands = 0;
  let notes = 0;
  let lastEventTime = null;

  for (const e of events) {
    if (e.type === 'phase' && e.phaseKey === phaseKey) {
      phaseStart = e.timestamp;
      actions = 0;
      commands = 0;
      notes = 0;
    }
    if (e.phase !== phaseKey) continue;
    lastEventTime = e.timestamp;
    if (e.type === 'agent_action') actions++;
    if (e.type === 'command') commands++;
    if (e.type === 'agent_note') notes++;
  }

  return { phaseStart, actions, commands, notes, lastEventTime };
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

function renderPhaseProgress(run, events) {
  if (!run?.phase) return '';
  const isRunning = ['running', 'queued', 'awaiting_input'].includes(run.status);
  const stats = getPhaseStats(events, run.phase);

  if (!stats.phaseStart) return '';

  const startTime = new Date(stats.phaseStart).getTime();
  const endTime = isRunning ? Date.now() : (stats.lastEventTime ? new Date(stats.lastEventTime).getTime() : Date.now());
  const elapsed = formatElapsed(endTime - startTime);

  const totalOps = stats.actions + stats.commands + stats.notes;

  return `
    <div class="phase-progress" id="phase-progress">
      <span class="phase-progress-timer" id="phase-timer" data-start="${stats.phaseStart}" data-running="${isRunning}">${elapsed}</span>
      <span class="phase-progress-dot">·</span>
      <span class="phase-progress-ops">${totalOps} operation${totalOps !== 1 ? 's' : ''}</span>
      ${stats.notes > 0 ? `<span class="phase-progress-dot">·</span><span class="phase-progress-detail">${stats.notes} note${stats.notes !== 1 ? 's' : ''}</span>` : ''}
      ${stats.commands > 0 ? `<span class="phase-progress-dot">·</span><span class="phase-progress-detail">${stats.commands} cmd${stats.commands !== 1 ? 's' : ''}</span>` : ''}
    </div>
  `;
}

function startPhaseTimer() {
  stopPhaseTimer();
  phaseElapsedTimer = setInterval(() => {
    const el = document.getElementById('phase-timer');
    const stillRunning = currentRunMeta && ['running', 'queued', 'awaiting_input'].includes(currentRunMeta.status);
    if (!el || !stillRunning) {
      stopPhaseTimer();
      return;
    }
    const start = new Date(el.dataset.start).getTime();
    el.textContent = formatElapsed(Date.now() - start);
  }, 1000);
}

function stopPhaseTimer() {
  if (phaseElapsedTimer) {
    clearInterval(phaseElapsedTimer);
    phaseElapsedTimer = null;
  }
}

async function fetchManualTestInstructions(runId, artifactKey) {
  if (manualTestRunId === runId && cachedManualTestInstructions !== null) {
    return cachedManualTestInstructions;
  }
  try {
    const response = await fetch(`/api/runs/${runId}/artifacts/${artifactKey}`);
    if (!response.ok) return null;
    const text = await response.text();
    cachedManualTestInstructions = text;
    manualTestRunId = runId;
    return text;
  } catch {
    return null;
  }
}

function renderManualTestSection(markdown) {
  if (!markdown) return '';
  const html = marked.parse(markdown);
  const task = currentTask;
  const run = currentRunMeta;
  const canReview = task && task.boardColumn === 'review' && run?.status === 'completed';
  const history = (run?.reviewFeedbackHistory || [])
    .map((entry) => `
      <div class="manual-test-feedback-history-item">
        <div class="manual-test-feedback-history-meta">Iteration ${esc(String(entry.iteration))} • ${esc(formatTimestamp(entry.createdAt))}</div>
        <div class="manual-test-feedback-history-body">${esc(entry.feedback)}</div>
      </div>
    `)
    .join('');

  return `
    <div class="manual-test-card">
      <div class="manual-test-header">
        <span class="manual-test-badge">Manual Validation</span>
      </div>
      ${run?.iteration ? `<div class="manual-test-iteration">Current iteration: ${esc(String(run.iteration))}</div>` : ''}
      <div class="manual-test-body">${html}</div>
      ${history ? `<div class="manual-test-feedback-history"><div class="manual-test-feedback-history-title">Reviewer feedback history</div>${history}</div>` : ''}
      ${canReview ? `
        <div class="manual-test-actions">
          <button class="manual-test-done-btn" id="btn-mark-done">Mark Task as Done</button>
          <button class="manual-test-reject-btn" id="btn-request-changes">Request Changes</button>
        </div>
        <form class="manual-test-reject-form hidden" id="manual-test-reject-form">
          <label class="manual-test-reject-label" for="manual-test-reject-feedback">Explain what is still wrong</label>
          <textarea id="manual-test-reject-feedback" class="manual-test-reject-textarea" rows="4" required placeholder="Describe the problems the agent must fix in the next iteration..."></textarea>
          <div class="manual-test-reject-actions">
            <button type="submit" class="manual-test-submit-feedback-btn">Send Feedback To Agent</button>
          </div>
        </form>
      ` : ''}
    </div>
  `;
}

function bindManualTestEvents() {
  const btn = document.getElementById('btn-mark-done');
  const rejectBtn = document.getElementById('btn-request-changes');
  const rejectForm = document.getElementById('manual-test-reject-form');
  if (!btn || !currentTask) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Moving...';
    try {
      await fetch(`/api/runs/${currentRunMeta.id}/review-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'accept' }),
      });
      const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toColumn: 'done' }),
      });
      if (!response.ok) throw new Error(await response.text());
      btn.textContent = 'Done!';
      await refreshCurrentTask(true);
    } catch (error) {
      console.error('Move to done failed:', error);
      btn.disabled = false;
      btn.textContent = 'Mark Task as Done';
    }
  });

  if (rejectBtn && rejectForm) {
    rejectBtn.addEventListener('click', () => {
      rejectForm.classList.toggle('hidden');
    });

    rejectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const textarea = document.getElementById('manual-test-reject-feedback');
      const feedback = textarea?.value?.trim();
      if (!feedback) return;

      rejectBtn.disabled = true;
      btn.disabled = true;

      try {
        const response = await fetch(`/api/runs/${currentRunMeta.id}/review-decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: 'request_changes', feedback }),
        });
        if (!response.ok) throw new Error(await response.text());
        await refreshCurrentTask(true);
      } catch (error) {
        console.error('Request changes failed:', error);
        rejectBtn.disabled = false;
        btn.disabled = false;
      }
    });
  }
}

function bindPhaseStepConfigEditors(taskRuntime) {
  if (currentTask?.storageColumn !== 'doing' || currentTask?.boardColumn !== 'doing') {
    return;
  }

  interactionTranscript.querySelectorAll('.phase-step-config').forEach((el) => {
    el.addEventListener('click', () => {
      const phaseKey = el.dataset.phaseConfig;
      const existing = el.parentElement.querySelector('.phase-step-editor');
      if (existing) {
        existing.remove();
        refreshCurrentTask(true).catch(() => {});
        return;
      }
      // Remove any other open editors
      interactionTranscript.querySelectorAll('.phase-step-editor').forEach((e) => e.remove());
      const editor = document.createElement('div');
      editor.className = 'phase-step-editor';
      el.parentElement.appendChild(editor);
      let draftSelection = normalizePhaseUiSelection(getPhaseSelection(taskRuntime, phaseKey));

      const renderEditor = () => {
        const normalized = normalizePhaseUiSelection(draftSelection);
        const agentOptions = [{ value: '', label: 'Agent...' }, ...availableAgents.map((agent) => ({ value: agent.id, label: agent.label }))];
        const modelOptions = [{ value: '', label: 'Model' }, ...getModelOptionsForAgent(normalized.agentId)];
        const effortOptions = getEffortsForSelection(normalized.agentId, normalized.model);

        editor.innerHTML = `
          <select class="phase-edit-sel" data-field="agent">${agentOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === normalized.agentId ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>
          <select class="phase-edit-sel" data-field="model" ${!normalized.agentId ? 'disabled' : ''}>${modelOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === normalized.model ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>
          ${effortOptions.length > 0
            ? `<select class="phase-edit-sel" data-field="effort">${[{ value: '', label: 'Effort' }, ...effortOptions.map((effort) => ({ value: effort, label: effort }))].map((option) => `<option value="${esc(option.value)}" ${option.value === normalized.effort ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
            : ''
          }
        `;

        editor.querySelectorAll('select').forEach((select) => {
          select.addEventListener('change', async (changeEvent) => {
            const field = changeEvent.target.dataset.field;
            if (field === 'agent') {
              draftSelection = normalizePhaseUiSelection({
                agentId: changeEvent.target.value,
                model: '',
                effort: '',
              });
            } else if (field === 'model') {
              draftSelection = normalizePhaseUiSelection({
                agentId: editor.querySelector('[data-field="agent"]')?.value || '',
                model: changeEvent.target.value,
                effort: '',
              });
            } else {
              draftSelection = normalizePhaseUiSelection({
                agentId: editor.querySelector('[data-field="agent"]')?.value || '',
                model: editor.querySelector('[data-field="model"]')?.value || '',
                effort: changeEvent.target.value,
              });
            }

            renderEditor();

            // Save in background — don't refresh, editor stays open
            try {
              await savePhaseAssignment(currentTask, phaseKey, draftSelection);
              clearTransientPhaseValidation(phaseKey);
              // Update the config label text without destroying the editor
              const configEl = el;
              const parts = [
                draftSelection.agentId ? agentLabel(draftSelection.agentId) : null,
                draftSelection.model || null,
                draftSelection.effort || null,
              ].filter(Boolean);
              if (parts.length > 0) {
                configEl.textContent = parts.join(' · ');
                configEl.classList.remove('phase-step-config-empty');
              }
            } catch (error) {
              const issue = error.issue || {
                phase: phaseKey,
                field: field || 'agent',
                error: error.message || 'Failed to save phase configuration',
              };
              setTransientPhaseValidation(issue);
              console.error('Phase config save failed:', error);
            }
          });
        });
      };

      renderEditor();
    });
  });
}

function renderTranscript() {
  // Always stop the timer first — restart only if confirmed running
  stopPhaseTimer();

  const run = currentRunMeta;
  const taskRuntime = currentTask?.runtime || {};
  const taskIsDoing = currentTask?.storageColumn === 'doing' && currentTask?.boardColumn === 'doing';

  if (!currentRunId) {
    const timelineHtml = taskIsDoing ? renderTimeline(null, taskRuntime, true) : '';
    interactionTranscript.innerHTML = `
      ${timelineHtml}
      <div class="latest-output">
        <div class="interaction-empty">No run started for this task yet.</div>
      </div>
    `;
    bindPhaseStepConfigEditors(taskRuntime);
    return;
  }

  const isRunning = run && ['running', 'queued', 'awaiting_input'].includes(run.status);
  const grouped = groupTranscriptEvents(currentRunEvents);
  const timelineHtml = renderTimeline(run, taskRuntime, taskIsDoing);
  const progressHtml = renderPhaseProgress(run, currentRunEvents);
  const contextHtml = renderRunContext(run);
  const artifactsHtml = renderArtifactLinks(run);
  const pendingInput = run?.pendingInputRequest || null;
  const inputCardHtml = pendingInput ? renderPendingInputCard(currentRunId, pendingInput) : '';

  // Check for manual test instructions artifact
  const hasManualTest = currentTask?.boardColumn === 'review' && run?.status === 'completed' && run?.artifacts?.manualTestInstructions;

  if (grouped.length === 0) {
    interactionTranscript.innerHTML = `
      ${timelineHtml}
      ${progressHtml}
      ${contextHtml}
      ${artifactsHtml}
      ${inputCardHtml}
      <div class="latest-output">
        <div class="interaction-empty">The run has started, but no output has been recorded yet.</div>
      </div>
    `;
    if (pendingInput) bindInputCardEvents();
    if (isRunning) startPhaseTimer();
    bindPhaseStepConfigEditors(taskRuntime);
    return;
  }

  const latest = getLatestOutput(grouped);
  const feedGroups = groupFeedEvents(latest);

  let latestHtml = '';
  if (feedGroups.length > 0) {
    latestHtml = feedGroups.map((group) => {
      const time = formatTimestamp(new Date(group.firstTs).toISOString());
      const shortTime = time.split(', ').pop() || time;
      const headerParts = [group.phaseLabel];
      if (group.runner) headerParts.push(group.runner);
      const headerText = headerParts.filter(Boolean).join(' · ');

      const eventsHtml = collapseFeedCommands(group.events).map(renderLatestEvent).join('');
      return `
        <div class="feed-group">
          <div class="feed-group-header">
            <span class="feed-group-label">${esc(headerText)}</span>
            <span class="feed-group-time">${esc(shortTime)}</span>
          </div>
          ${eventsHtml}
        </div>
      `;
    }).join('');
  } else {
    latestHtml = '<div class="interaction-empty">Waiting for agent output...</div>';
  }

  // Placeholder for manual test section — will be filled async
  const manualTestPlaceholder = hasManualTest ? '<div id="manual-test-placeholder"></div>' : '';

  interactionTranscript.innerHTML = `
    ${timelineHtml}
    ${progressHtml}
    ${contextHtml}
    ${artifactsHtml}
    ${inputCardHtml}
    ${manualTestPlaceholder}
    <div class="latest-output">
      <div class="latest-output-label">Activity Log</div>
      <div class="latest-output-log">${latestHtml}</div>
    </div>
  `;

  if (pendingInput) bindInputCardEvents();
  if (isRunning) startPhaseTimer();

  // Auto-scroll the log to top (newest events first)
  const logEl = interactionTranscript.querySelector('.latest-output-log');
  if (logEl) logEl.scrollTop = 0;

  bindPhaseStepConfigEditors(taskRuntime);

  // Async: fetch and render manual test instructions
  if (hasManualTest && currentRunId) {
    fetchManualTestInstructions(currentRunId, hasManualTest).then((markdown) => {
      const placeholder = document.getElementById('manual-test-placeholder');
      if (placeholder && markdown) {
        placeholder.outerHTML = renderManualTestSection(markdown);
        bindManualTestEvents();
      }
    });
  }
}

function renderArtifactLinks(run) {
  if (!run?.id || !run?.artifacts) {
    return '';
  }

  const links = [
    run.artifacts.agentPlan ? { key: run.artifacts.agentPlan, label: 'Agent Plan' } : null,
    run.artifacts.generatedPlan ? { key: run.artifacts.generatedPlan, label: 'Generated Plan' } : null,
    run.artifacts.validateSummary ? { key: run.artifacts.validateSummary, label: 'Validate Summary' } : null,
    run.artifacts.manualTestInstructions ? { key: run.artifacts.manualTestInstructions, label: 'Manual Test Instructions' } : null,
    run.artifacts.promptStats ? { key: run.artifacts.promptStats, label: 'Prompt Stats' } : null,
    run.artifacts.claudeDebug ? { key: run.artifacts.claudeDebug, label: 'Claude Debug Log' } : null,
    run.artifacts.claudeStdoutRaw ? { key: run.artifacts.claudeStdoutRaw, label: 'Claude Raw Stdout' } : null,
    run.artifacts.claudeStderrRaw ? { key: run.artifacts.claudeStderrRaw, label: 'Claude Raw Stderr' } : null,
  ].filter(Boolean);

  if (links.length === 0) {
    return '';
  }

  return `
    <div class="automation-artifacts">
      <div class="detail-section-label">Run Artifacts</div>
      <div class="automation-artifact-links">
        ${links.map((link) => `<a class="run-link" href="/api/runs/${run.id}/artifacts/${link.key}" target="_blank" rel="noreferrer">${esc(link.label)}</a>`).join('')}
      </div>
    </div>
  `;
}

function renderRawLog() {
  if (!currentRunId) {
    interactionRawContent.textContent = 'No raw log available yet.';
    return;
  }
  interactionRawContent.textContent = currentRawLog || 'The raw log is empty for this run.';
}

function renderInteractionInput(runId, request) {
  // Input is now handled inline by the input card in the activity view.
  // Hide the legacy bottom input section; keep it as fallback for the Full Log tab.
  if (!request || !runId || ['plan', 'transcript'].includes(currentInteractionTab)) {
    interactionInput.classList.add('hidden');
    interactionInput.innerHTML = '';
    return;
  }

  if (request.kind === 'confirm') {
    const choices = request.choices?.length ? request.choices : ['Approve', 'Decline'];
    interactionInput.innerHTML = `
      <div class="interaction-input-shell">
        <div class="interaction-input-title">Human Input Required</div>
        <div class="interaction-input-prompt">${esc(request.prompt)}</div>
        <div class="interaction-input-actions">
          ${choices.map((choice) => `<button class="interaction-choice-button" data-answer="${esc(choice)}">${esc(choice)}</button>`).join('')}
        </div>
      </div>
    `;

    interactionInput.querySelectorAll('.interaction-choice-button').forEach((button) => {
      button.addEventListener('click', async () => {
        await submitRunInput(runId, request.requestId, button.dataset.answer);
      });
    });
  } else if (request.kind === 'choice') {
    const choices = request.choices || [];
    interactionInput.innerHTML = `
      <form class="interaction-input-shell" id="interaction-input-form">
        <div class="interaction-input-title">Pick One To Continue</div>
        <div class="interaction-input-prompt">${esc(request.prompt)}</div>
        <select class="interaction-select" id="interaction-choice-select" required>
          <option value="">Select…</option>
          ${choices.map((choice) => `<option value="${esc(choice)}">${esc(choice)}</option>`).join('')}
        </select>
        <button class="interaction-submit" type="submit">Send Answer</button>
      </form>
    `;

    document.getElementById('interaction-input-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const select = document.getElementById('interaction-choice-select');
      if (!select.value) {
        return;
      }
      await submitRunInput(runId, request.requestId, select.value);
    });
  } else {
    interactionInput.innerHTML = `
      <form class="interaction-input-shell" id="interaction-input-form">
        <div class="interaction-input-title">Send Human Input</div>
        <div class="interaction-input-prompt">${esc(request.prompt)}</div>
        <textarea class="interaction-textarea" id="interaction-textarea" rows="4" required placeholder="Write your answer here..."></textarea>
        <button class="interaction-submit" type="submit">Send Answer</button>
      </form>
    `;

    document.getElementById('interaction-input-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const textarea = document.getElementById('interaction-textarea');
      if (!textarea.value.trim()) {
        return;
      }
      await submitRunInput(runId, request.requestId, textarea.value.trim());
    });
  }

  interactionInput.classList.remove('hidden');
}

async function submitRunInput(runId, requestId, answer) {
  try {
    const response = await fetch(`/api/runs/${runId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, answer }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    interactionInput.classList.add('hidden');
    interactionInput.innerHTML = '';
    await refreshCurrentTask(true);
  } catch (error) {
    console.error('Run input submit failed:', error);
  }
}

async function loadRunEvents(runId) {
  const response = await fetch(`/api/runs/${runId}/events`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  currentRunEvents = payload.events || [];
  currentRunMeta = payload.run || null;
  renderTranscript();
}

async function loadRawLog(runId) {
  const response = await fetch(`/api/runs/${runId}/terminal`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  currentRawLog = await response.text();
  renderRawLog();
}

function connectRunSocket(runId) {
  disconnectRunSocket();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  activeRunSocket = new WebSocket(`${protocol}//${window.location.host}/ws/runs/${runId}`);

  activeRunSocket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'replay') {
        currentRunEvents = payload.events || [];
        currentRunMeta = payload.run || currentRunMeta;
      } else if (payload.type === 'event') {
        currentRunEvents.push(payload.event);
        if (payload.run) {
          currentRunMeta = payload.run;
        }
      } else if (payload.type === 'state') {
        currentRunMeta = payload.run;
      }

      if (currentTask) {
        currentTask.runtime = currentTask.runtime || {};
        currentTask.runtime.run = currentRunMeta;
        currentTask.runtime.activeRunId = currentRunMeta?.status && ['completed', 'failed', 'stopped', 'interrupted'].includes(currentRunMeta.status)
          ? null
          : runId;
      }

      renderInteractionHeader(currentTask);
      syncInteractionTabLocks();
      if (currentTask && !isCurrentPlanApproved() && currentInteractionTab !== 'plan') {
        switchInteractionTab('plan').catch((error) => console.error('Tab switch failed:', error));
        return;
      }
      renderTranscript();
      renderInteractionInput(runId, currentRunMeta?.pendingInputRequest || null);
    } catch (error) {
      console.error('Run socket parse failed:', error);
    }
  };

  activeRunSocket.onclose = () => {
    if (currentTask) {
      setTimeout(() => {
        refreshCurrentTask(true).catch((error) => console.error('Task refresh failed after run socket close:', error));
      }, 700);
    }
  };
}

async function ensureInteractionForTask(task, forceReload = false) {
  const runtime = task.runtime || {};
  const run = runtime.run;
  const runId = run?.id || runtime.activeRunId || null;
  const activeRun = Boolean(runId && run && ['queued', 'running', 'stopping', 'awaiting_input'].includes(run.status));

  renderInteractionHeader(task);

  if (!runId) {
    resetInteractionPanel();
    renderInteractionHeader(task);
    renderPlanPanel(task);
    renderTranscript();
    return;
  }

  const needsReload = forceReload || runId !== currentRunId;
  currentRunId = runId;

  if (needsReload) {
    currentRunEvents = [];
    currentRunMeta = run || null;
    currentRawLog = '';
    renderTranscript();
    renderRawLog();

    await Promise.all([
      loadRunEvents(runId),
      currentInteractionTab === 'raw' ? loadRawLog(runId) : Promise.resolve(),
    ]);
  } else {
    currentRunMeta = run || currentRunMeta;
  }

  renderInteractionHeader(task);
  renderInteractionInput(runId, currentRunMeta?.pendingInputRequest || null);

  if (activeRun && !activeRunSocket) {
    connectRunSocket(runId);
  } else if (!activeRun) {
    disconnectRunSocket();
    if (currentInteractionTab === 'raw' || forceReload) {
      await loadRawLog(runId);
    }
  }

  if (currentInteractionTab === 'terminal') {
    const cwd = currentRunMeta?.executionContext?.primaryWorktreePath || run?.executionContext?.primaryWorktreePath || '';
    initTerminal(cwd);
  }
}

function findTaskByFilename(data, filename) {
  for (const column of COLUMN_ORDER) {
    const task = (data[column] || []).find((item) => item.filename === filename);
    if (task) {
      return task;
    }
  }
  return null;
}

function resetPlanRefinementState() {
  planRefinementOpen = false;
  planRefinementDraftInput = '';
}

function openDetail(task, options = {}) {
  const preservePlanPanel = Boolean(
    options.preserveInteraction &&
    currentTask?.filename === task.filename &&
    currentInteractionTab === 'plan' &&
    planRefinementOpen &&
    interactionPlan.querySelector('#plan-refinement-section') &&
    !interactionPlan.querySelector('.plan-drafting-placeholder'),
  );
  if (planRefinementTaskFilename !== task.filename) {
    resetPlanRefinementState();
    planRefinementTaskFilename = task.filename;
  }
  currentTask = task;
  history.replaceState(null, '', `#task/${task.boardColumn}/${task.filename}`);

  board.classList.add('hidden');
  archiveView.classList.add('hidden');
  taskView.classList.remove('hidden');
  navBoard.classList.add('active');
  navArchive.classList.remove('active');

  renderTaskDetail(task, { preservePlanPanel });
  syncInteractionTabLocks();
  if (!options.preserveInteraction) {
    switchInteractionTab(task.runtime?.planState === 'approved' ? 'transcript' : 'plan')
      .catch((error) => console.error('Tab switch failed:', error));
  }
  ensureInteractionForTask(task, !options.preserveInteraction).catch((error) => {
    console.error('Interaction attach failed:', error);
  });
  startTaskPolling();
}

async function refreshCurrentTask(forceInteraction = false) {
  if (!currentTask || isEditingTask()) {
    return;
  }
  if (!(await autosaveCurrentPlan())) {
    return;
  }

  const previousRunId = currentTask.runtime?.run?.id || currentTask.runtime?.activeRunId || null;
  const data = await fetchBoardData();
  renderBoard(data);

  let nextTask = findTaskByFilename(data, currentTask.filename);
  if (!nextTask && currentTask.boardColumn === 'done') {
    const archiveResponse = await fetch('/api/tasks/archived');
    if (archiveResponse.ok) {
      const archived = await archiveResponse.json();
      nextTask = archived.find((task) => task.filename === currentTask.filename);
    }
  }

  if (!nextTask) {
    return;
  }

  const nextRunId = nextTask.runtime?.run?.id || nextTask.runtime?.activeRunId || null;
  const preserveInteraction = !forceInteraction && previousRunId === nextRunId;
  clearTransientPhaseValidation();
  openDetail(nextTask, { preserveInteraction });
}

async function refreshCurrentTaskAndShowPlan() {
  await refreshCurrentTask(true);
  await switchInteractionTab('plan');
  syncInteractionTabLocks();
}

async function refreshCurrentTaskAndShowActivity() {
  await refreshCurrentTask(true);
  await switchInteractionTab('transcript');
  syncInteractionTabLocks();
}

function isEditingTask() {
  const activeElement = document.activeElement;
  if (!activeElement || !taskView.contains(activeElement)) {
    return false;
  }
  if (activeElement.readOnly || activeElement.disabled) {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName);
}

function draftPlanSelection(task) {
  const runtime = task?.runtime || {};
  return normalizePhaseUiSelection(runtime.draftPlanConfig || getPhaseSelection(runtime, 'planning'));
}

function defaultDraftSelectionForMode(mode) {
  if (mode === 'deep_draft') {
    return normalizePhaseUiSelection({
      agentId: 'codex',
      model: 'gpt-5.4',
      effort: 'xhigh',
    });
  }

  return normalizePhaseUiSelection({
    agentId: 'codex',
    model: 'gpt-5.3-codex-spark',
    effort: 'xhigh',
  });
}

function secondOpinionSelection(task) {
  const runtime = task?.runtime || {};
  return normalizePhaseUiSelection(runtime.secondOpinionConfig || {
    agentId: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
  });
}

function syncSecondOpinionControls(next = {}) {
  return syncPhaseSelectControls(
    document.getElementById('second-opinion-agent'),
    document.getElementById('second-opinion-model'),
    document.getElementById('second-opinion-effort'),
    document.getElementById('second-opinion-effort-field'),
    next,
  );
}

function secondOpinionPayload() {
  const toggle = document.getElementById('second-opinion-enabled');
  if (!toggle?.checked) {
    return { secondOpinionEnabled: false };
  }

  const secondOpinion = syncSecondOpinionControls();
  return {
    secondOpinionEnabled: true,
    secondOpinionAgentId: secondOpinion.agentId,
    secondOpinionModel: secondOpinion.model,
    secondOpinionEffort: secondOpinion.effort,
  };
}

function deriveSecondOpinionStep() {
  const messages = draftPlanEvents
    .filter((e) => e.type === 'system')
    .map((e) => e.message);
  if (messages.includes('Final plan synthesis.')) return 'final';
  if (messages.includes('Second opinion requested.')) return 'second';
  if (messages.includes('Initial plan drafted.')) return 'initial-done';
  return 'initial';
}

function buildSecondOpinionStepsHtml() {
  const phase = deriveSecondOpinionStep();
  const steps = [
    { label: 'Generating candidate plan' },
    { label: 'Getting second opinion' },
    { label: 'Synthesizing final plan' },
  ];
  const phaseOrder = { initial: 0, 'initial-done': 1, second: 1, 'second-done': 2, final: 2 };
  const activeIndex = phaseOrder[phase] ?? 0;

  return steps.map((step, i) => {
    let icon, cls;
    if (i < activeIndex) {
      icon = '<span class="plan-step-check">&#10003;</span>';
      cls = 'plan-step-done';
    } else if (i === activeIndex) {
      icon = '<span class="plan-draft-spinner"></span>';
      cls = 'plan-step-active';
    } else {
      icon = '<span class="plan-step-pending-icon">&#8226;</span>';
      cls = 'plan-step-pending';
    }
    return `<div class="plan-step ${cls}">${icon}<span>${step.label}${i === activeIndex ? '...' : ''}</span></div>`;
  }).join('');
}

function updateDraftPlanSteps() {
  const container = document.getElementById('plan-draft-steps');
  if (!container) return;
  const stepsEl = container.querySelector('.plan-steps-list');
  if (!stepsEl) return;
  stepsEl.innerHTML = buildSecondOpinionStepsHtml();
}

function renderDraftPlanStatus(run) {
  if (!run?.status) {
    return '';
  }
  const active = ['queued', 'running', 'awaiting_input'].includes(run.status);
  if (active) {
    if (run.secondOpinionEnabled) {
      return `
        <div class="plan-draft-status plan-draft-status-active plan-draft-steps" id="plan-draft-steps">
          <div class="plan-steps-list">${buildSecondOpinionStepsHtml()}</div>
          <button class="plan-draft-stop-btn" id="plan-draft-stop-btn">Stop</button>
        </div>
      `;
    }
    return `
      <div class="plan-draft-status plan-draft-status-active">
        <span class="plan-draft-spinner"></span>
        <span>Generating plan...</span>
        <button class="plan-draft-stop-btn" id="plan-draft-stop-btn">Stop</button>
      </div>
    `;
  }
  if (run.errorMessage) {
    return `
      <div class="plan-draft-status plan-draft-status-error">
        <span>${esc(run.errorMessage)}</span>
      </div>
    `;
  }
  return '';
}

function renderRequestedChangesHistory(task) {
  const run = task?.runtime?.draftPlanRun || null;
  const active = run && ['queued', 'running', 'awaiting_input'].includes(run.status);
  const entries = [...(currentPlanFeedbackHistory || [])]
    .filter((entry) => entry.feedback && entry.kind !== 'human_approval');
  if (active && run.additionalInput) {
    entries.push({
      iteration: run.iteration || entries.length + 1,
      timestamp: run.startedAt || run.updatedAt,
      kind: 'ongoing',
      status: 'ongoing',
      feedback: run.additionalInput,
    });
  }
  if (entries.length === 0) {
    return '';
  }

  return `
    <details class="requested-changes-history" ${active ? 'open' : ''}>
      <summary>Requested Changes (${entries.length})</summary>
      <div class="requested-changes-list">
        ${entries.map((entry) => `
          <article class="requested-change-item">
            <div class="requested-change-meta">
              <span>${entry.status === 'ongoing' ? 'Ongoing' : `Iteration ${esc(entry.iteration || '')}`}</span>
              ${entry.timestamp ? `<span>${esc(formatTimestamp(entry.timestamp))}</span>` : ''}
            </div>
            <p>${esc(entry.feedback)}</p>
          </article>
        `).join('')}
      </div>
    </details>
  `;
}

function planStateLabel(state) {
  if (state === 'approved') return 'Approved';
  if (state === 'generated') return 'Generated';
  return 'No Plan';
}

function renderPlanStateBadge(task) {
  const state = task?.runtime?.planState || ((task?.plans_files || []).length > 0 ? 'generated' : 'todo');
  return `<span class="badge badge-run plan-state-badge plan-state-${esc(state)}">${esc(planStateLabel(state))}</span>`;
}

function disconnectDraftSocket() {
  if (activeDraftSocket) {
    try { activeDraftSocket.close(); } catch { /* ignore */ }
    activeDraftSocket = null;
  }
}

function connectDraftSocket(runId) {
  disconnectDraftSocket();
  draftPlanEvents = [];
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  activeDraftSocket = new WebSocket(`${protocol}//${window.location.host}/ws/runs/${runId}`);

  activeDraftSocket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'replay') {
        draftPlanEvents = payload.events || [];
      } else if (payload.type === 'event') {
        draftPlanEvents.push(payload.event);
      }
      renderDraftPlanLog();
      updateDraftPlanSteps();

      if (payload.run) {
        const finished = ['completed', 'failed', 'stopped', 'interrupted'].includes(payload.run.status);
        if (finished) {
          disconnectDraftSocket();
          refreshCurrentTask(true).catch((err) => console.error('Refresh after draft failed:', err));
        }
      }
    } catch (err) {
      console.error('Draft socket parse failed:', err);
    }
  };

  activeDraftSocket.onclose = () => {
    activeDraftSocket = null;
  };
}

function mergeDraftPlanEvents(events) {
  const kept = events.filter((e) =>
    ['agent_note', 'agent_action', 'command', 'system', 'agent_status', 'phase', 'success', 'error'].includes(e.type));
  const merged = [];
  for (const event of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'command' && (event.type === 'success' || event.type === 'error')) {
      prev.result = { type: event.type, message: event.message };
      prev.timestamp = event.timestamp;
      continue;
    }
    merged.push({ ...event });
  }
  return merged.filter((e) => e.type !== 'success');
}

function renderDraftPlanLog() {
  const container = document.getElementById('plan-draft-log');
  if (!container) return;
  const merged = mergeDraftPlanEvents(draftPlanEvents);
  const html = collapseFeedCommands(merged)
    .reverse()
    .map(renderLatestEvent)
    .join('');
  container.innerHTML = html || '<div class="feed-row feed-row-system"><div class="feed-body"><p class="feed-text feed-text-muted">Waiting for agent output...</p></div></div>';
  container.scrollTop = 0;
}

function renderDraftRevisionHeader(run) {
  const history = [...(currentPlanFeedbackHistory || [])]
    .filter((entry) => entry.feedback && entry.kind !== 'human_approval');
  const current = run?.additionalInput || '';
  const hasHistory = history.length > 0;

  if (!current && !hasHistory) return '';

  const historyHtml = hasHistory ? `
    <details class="draft-revision-history">
      <summary class="draft-revision-toggle">Previous revisions (${history.length})</summary>
      <div class="draft-revision-list">
        ${history.map((entry, i) => `
          <div class="draft-revision-entry">
            <span class="draft-revision-num">#${i + 1}</span>
            <span class="draft-revision-text">${esc(entry.feedback)}</span>
          </div>
        `).join('')}
      </div>
    </details>
  ` : '';

  return `
    <div class="draft-revision-header">
      ${current ? `<div class="draft-revision-current"><span class="draft-revision-label">Request</span><span class="draft-revision-text">${esc(current)}</span></div>` : ''}
      ${historyHtml}
    </div>
  `;
}

function renderDraftPlanControls(task, options = {}) {
  const selection = draftPlanSelection(task);
  const secondSelection = secondOpinionSelection(task);
  const run = task?.runtime?.draftPlanRun || null;
  const active = run && ['queued', 'running', 'awaiting_input'].includes(run.status);
  const showEffort = shouldShowEffort(selection.agentId, selection.model);
  const showSecondEffort = shouldShowEffort(secondSelection.agentId, secondSelection.model);
  const secondOpinionActive = Boolean(run?.secondOpinionEnabled);
  const hasPlan = Boolean(options.hasPlan);
  const selectedMode = task?.runtime?.draftPlanMode || (hasPlan ? 'fast_refine' : 'deep_draft');
  const activeStatusHtml = `
    ${renderDraftPlanStatus(run)}
    ${active ? `<div class="latest-output">${renderDraftRevisionHeader(run)}<div class="latest-output-log plan-draft-log" id="plan-draft-log"></div></div>` : ''}
  `;

  if (hasPlan && active) {
    return `
      <div class="plan-refinement-section plan-refinement-section-active" id="plan-refinement-section">
        ${activeStatusHtml}
      </div>
    `;
  }

  const configHtml = `
    ${activeStatusHtml}
    ${hasPlan ? `
      <div class="plan-refinement-titlebar">
        <span>Request plan changes</span>
        <button class="plan-refinement-close-btn" id="plan-refinement-close-btn" type="button" aria-label="Close request changes form">&times;</button>
      </div>
    ` : ''}
    <div class="draft-plan-config">
      <label>
        <span>Mode</span>
        <select class="phase-edit-sel" id="draft-plan-mode" ${active ? 'disabled' : ''}>
          <option value="fast_refine" ${selectedMode === 'fast_refine' ? 'selected' : ''}>Fast refine (Spark/xhigh)</option>
          <option value="deep_draft" ${selectedMode === 'deep_draft' ? 'selected' : ''}>Deep draft (GPT-5.4/xhigh)</option>
        </select>
      </label>
      <label>
        <span>Draft agent</span>
        <select class="phase-edit-sel" id="draft-plan-agent" ${active ? 'disabled' : ''}>${renderAgentOptions(selection.agentId)}</select>
      </label>
      <label>
        <span>Model</span>
        <select class="phase-edit-sel" id="draft-plan-model" ${active || !selection.agentId ? 'disabled' : ''}>${renderModelOptions(selection.agentId, selection.model)}</select>
      </label>
      <label class="${showEffort ? '' : 'hidden'}" id="draft-plan-effort-field">
        <span>Effort</span>
        <select class="phase-edit-sel" id="draft-plan-effort" ${active ? 'disabled' : ''}>${renderEffortOptions(selection.agentId, selection.model, selection.effort)}</select>
      </label>
    </div>
    <div class="second-opinion-config">
      <label class="second-opinion-toggle">
        <input type="checkbox" id="second-opinion-enabled" ${secondOpinionActive ? 'checked' : ''} ${active ? 'disabled' : ''}>
        <span>Get second opinion</span>
      </label>
      <div class="second-opinion-fields${secondOpinionActive ? '' : ' hidden'}" id="second-opinion-fields">
        <label>
          <span>Second opinion agent</span>
          <select class="phase-edit-sel" id="second-opinion-agent" ${active ? 'disabled' : ''}>${renderAgentOptions(secondSelection.agentId)}</select>
        </label>
        <label>
          <span>Model</span>
          <select class="phase-edit-sel" id="second-opinion-model" ${active || !secondSelection.agentId ? 'disabled' : ''}>${renderModelOptions(secondSelection.agentId, secondSelection.model)}</select>
        </label>
        <label class="${showSecondEffort ? '' : 'hidden'}" id="second-opinion-effort-field">
          <span>Effort</span>
          <select class="phase-edit-sel" id="second-opinion-effort" ${active ? 'disabled' : ''}>${renderEffortOptions(secondSelection.agentId, secondSelection.model, secondSelection.effort)}</select>
        </label>
      </div>
    </div>
    <label class="plan-draft-input">
      <span>${hasPlan ? 'Feedback for next iteration' : 'Input for the agent'}</span>
      <textarea id="draft-plan-input" required ${active ? 'disabled' : ''} placeholder="${hasPlan ? 'Tell the agent what to change in the next plan.' : 'Constraints, priorities, open questions, or implementation direction.'}">${hasPlan ? esc(planRefinementDraftInput) : ''}</textarea>
    </label>
  `;

  if (hasPlan) {
    const collapsed = !planRefinementOpen;
    return `
      <div class="plan-refinement-section${collapsed ? ' hidden' : ''}" id="plan-refinement-section">
        ${configHtml}
      </div>
    `;
  }

  return `
    <div class="plan-empty-state">
      <h3>Generate Plan ${renderPlanStateBadge(task)}</h3>
      ${configHtml}
      <button class="plan-primary-btn" id="draft-plan-button" ${active ? 'disabled' : ''}>${active ? 'Drafting...' : 'Generate Plan'}</button>
    </div>
  `;
}

function bindDraftPlanControls(task) {
  const agentSelect = document.getElementById('draft-plan-agent');
  const modelSelect = document.getElementById('draft-plan-model');
  const effortSelect = document.getElementById('draft-plan-effort');
  const effortField = document.getElementById('draft-plan-effort-field');
  const secondOpinionToggle = document.getElementById('second-opinion-enabled');
  const secondOpinionFields = document.getElementById('second-opinion-fields');
  const secondOpinionAgentSelect = document.getElementById('second-opinion-agent');
  const secondOpinionModelSelect = document.getElementById('second-opinion-model');
  const secondOpinionEffortSelect = document.getElementById('second-opinion-effort');
  const secondOpinionEffortField = document.getElementById('second-opinion-effort-field');
  const button = document.getElementById('draft-plan-button');
  const input = document.getElementById('draft-plan-input');
  const modeSelect = document.getElementById('draft-plan-mode');
  if (!agentSelect || !modelSelect || !task) {
    return;
  }

  const sync = (next = {}) => syncPhaseSelectControls(agentSelect, modelSelect, effortSelect, effortField, next);
  if (modeSelect) {
    modeSelect.addEventListener('change', () => sync(defaultDraftSelectionForMode(modeSelect.value)));
  }
  agentSelect.addEventListener('change', () => sync({ agentId: agentSelect.value, model: '', effort: '' }));
  modelSelect.addEventListener('change', () => sync({ model: modelSelect.value, effort: '' }));
  if (effortSelect) {
    effortSelect.addEventListener('change', () => sync({ effort: effortSelect.value }));
  }
  if (secondOpinionToggle && secondOpinionFields) {
    secondOpinionToggle.addEventListener('change', () => {
      secondOpinionFields.classList.toggle('hidden', !secondOpinionToggle.checked);
      if (secondOpinionToggle.checked) {
        syncSecondOpinionControls();
      }
    });
  }
  if (secondOpinionAgentSelect) {
    secondOpinionAgentSelect.addEventListener('change', () => syncSecondOpinionControls({ agentId: secondOpinionAgentSelect.value, model: '', effort: '' }));
  }
  if (secondOpinionModelSelect) {
    secondOpinionModelSelect.addEventListener('change', () => syncSecondOpinionControls({ model: secondOpinionModelSelect.value, effort: '' }));
  }
  if (secondOpinionEffortSelect) {
    secondOpinionEffortSelect.addEventListener('change', () => syncSecondOpinionControls({ effort: secondOpinionEffortSelect.value }));
  }

  if (button) {
    button.addEventListener('click', async () => {
      const selection = sync();
      const feedback = input?.value?.trim() || '';
      if (!feedback) {
        input?.focus();
        return;
      }
      if (!(await autosaveCurrentPlan())) {
        return;
      }
      button.disabled = true;
      button.textContent = 'Drafting...';
      try {
        const response = await fetch(`/api/tasks/${task.boardColumn}/${task.filename}/plan-draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            additionalInput: feedback,
            agentId: selection.agentId,
            model: selection.model,
            effort: selection.effort,
            draftPlanMode: modeSelect?.value || 'fast_refine',
            ...secondOpinionPayload(),
          }),
        });
        if (!response.ok) {
          const issue = await readApiError(response);
          throw new Error(issue.error || 'Failed to draft plan');
        }
        const payload = await response.json();
        currentPlanPath = payload.planPath || currentPlanPath;
        currentPlanDirty = false;
        await refreshCurrentTask(true);
      } catch (error) {
        console.error('Plan draft failed:', error);
        button.disabled = false;
        button.textContent = 'Generate Plan';
      }
    });
  }
}

function renderPlanPanel(task) {
  if (!interactionPlan) {
    return;
  }
  syncInteractionTabLocks();
  if (!task) {
    interactionPlan.innerHTML = '<div class="interaction-empty">Open a task to inspect or draft its plan.</div>';
    return;
  }
  if (currentPlanDirty && interactionPlan.querySelector('#plan-editor')) {
    return;
  }

  const plans = task.plans_files || [];
  if (plans.length === 0) {
    currentPlanPath = null;
    currentPlanRaw = '';
    currentPlanDirty = false;
    currentPlanFeedbackHistory = [];
    interactionPlan.innerHTML = renderDraftPlanControls(task);
    bindDraftPlanControls(task);
    return;
  }

  if (!currentPlanPath || !plans.includes(currentPlanPath)) {
    currentPlanPath = plans[0];
  }

  interactionPlan.innerHTML = `
    <div class="plan-panel">
      <div class="plan-panel-header">
        <div>
          <h3>Implementation Plan ${renderPlanStateBadge(task)}</h3>
        </div>
        ${plans.length > 1 ? `<div class="plan-menu">
          ${plans.map((planRef) => `<button class="plan-menu-item${planRef === currentPlanPath ? ' plan-menu-item-active' : ''}" data-plan="${esc(planRef)}">${esc(pathLabel(planRef))}</button>`).join('')}
        </div>` : ''}
      </div>
      <div class="interaction-empty">Loading plan...</div>
    </div>
  `;

  interactionPlan.querySelectorAll('.plan-menu-item').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!(await autosaveCurrentPlan())) {
        return;
      }
      currentPlanPath = button.dataset.plan;
      currentPlanDirty = false;
      renderPlanPanel(task);
    });
  });

  loadPlanIntoRight(currentPlanPath);
}

function pathLabel(planPath) {
  return (planPath || '').split('/').pop() || planPath || 'plan';
}

function setPlanSaveStatus(message, tone = '') {
  const el = document.getElementById('plan-save-status');
  if (!el) {
    return;
  }
  el.textContent = message;
  el.className = `plan-save-status${tone ? ` plan-save-status-${tone}` : ''}${message ? '' : ' hidden'}`;
}

function showPlanActionError(message) {
  setPlanSaveStatus(message, 'error');
  if (!document.getElementById('plan-action-error')) {
    const panel = interactionPlan.querySelector('.plan-panel');
    if (panel) {
      panel.insertAdjacentHTML('afterbegin', '<div class="plan-action-error" id="plan-action-error"></div>');
    }
  }
  const errorEl = document.getElementById('plan-action-error');
  if (errorEl) {
    errorEl.textContent = message;
  }
}

async function autosaveCurrentPlan() {
  const editor = document.getElementById('plan-editor');
  if (!currentPlanDirty || !currentPlanPath || !editor) {
    return true;
  }

  setPlanSaveStatus('Saving...', 'pending');
  try {
    await savePlan(currentPlanPath, editor.value);
    currentPlanRaw = editor.value;
    currentPlanDirty = false;
    setPlanSaveStatus('', '');
    return true;
  } catch (error) {
    console.error('Plan autosave failed:', error);
    setPlanSaveStatus('Save failed. Try again before continuing.', 'error');
    return false;
  }
}

async function loadPlanIntoRight(planPath) {
  const token = ++currentPlanLoadToken;
  try {
    const response = await fetch(`/api/plans/${planPath}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const plan = await response.json();
    if (token !== currentPlanLoadToken || plan.path !== currentPlanPath) {
      return;
    }
    currentPlanRaw = plan.raw || '';
    currentPlanFeedbackHistory = plan.feedbackHistory || [];
    currentPlanDirty = false;
    renderPlanEditor(plan);
  } catch (error) {
    console.error('Plan load failed:', error);
    interactionPlan.innerHTML = `<div class="interaction-empty">Failed to load plan: ${esc(error.message)}</div>`;
  }
}

function renderPlanDraftingPlaceholder() {
  return `
    <div class="plan-drafting-placeholder">
      <span class="plan-drafting-spinner"></span>
      <div>
        <strong>Generating final plan...</strong>
        <span>The saved plan will appear here when generation finishes.</span>
      </div>
    </div>
  `;
}

function renderPlanEditor(plan) {
  const plans = currentTask?.plans_files || [];
  const planState = currentTask?.runtime?.planState || 'generated';
  const approved = planState === 'approved';
  const draftRun = currentTask?.runtime?.draftPlanRun || null;
  const drafting = draftRun && ['queued', 'running', 'awaiting_input'].includes(draftRun.status);
  interactionPlan.innerHTML = `
    <div class="plan-panel">
      ${approved || drafting ? '' : `
        <div class="plan-action-strip">
          <button class="plan-action-btn plan-action-request" id="plan-request-changes-btn">
            <span class="plan-action-icon">&#9998;</span>
            <span>Request Changes</span>
          </button>
          <span class="plan-action-divider"></span>
          <button class="plan-action-btn plan-action-approve" id="plan-approve-btn" ${planState === 'todo' || !plan.raw?.trim() || planRefinementOpen ? 'disabled' : ''}>
            <span class="plan-action-icon">&#10003;</span>
            <span>Approve Plan</span>
          </button>
        </div>
      `}
      <div class="plan-panel-header">
        <div>
          <h3>${esc(plan.path)} ${renderPlanStateBadge(currentTask)}</h3>
        </div>
        <div class="plan-editor-actions">
          ${approved
            ? '<button class="plan-request-changes-btn" id="plan-recall-btn">Recall Plan</button>'
            : ''}
          ${plans.length > 1 ? `<div class="plan-menu">
            ${plans.map((planRef) => `<button class="plan-menu-item${planRef === plan.path ? ' plan-menu-item-active' : ''}" data-plan="${esc(planRef)}">${esc(pathLabel(planRef))}</button>`).join('')}
          </div>` : ''}
        </div>
      </div>
      ${approved ? '' : renderDraftPlanControls(currentTask, { hasPlan: true })}
      <span class="plan-save-status hidden" id="plan-save-status"></span>
      ${drafting
        ? renderPlanDraftingPlaceholder()
        : `<textarea class="plan-editor plan-editor-right" id="plan-editor" ${approved ? 'readonly' : ''}>${esc(plan.raw || '')}</textarea>`}
    </div>
  `;

  interactionPlan.querySelectorAll('.plan-menu-item').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!(await autosaveCurrentPlan())) {
        return;
      }
      currentPlanPath = button.dataset.plan;
      currentPlanDirty = false;
      renderPlanPanel(currentTask);
    });
  });

  const editor = document.getElementById('plan-editor');
  const approveButton = document.getElementById('plan-approve-btn');
  if (editor) {
    editor.addEventListener('input', () => {
      currentPlanDirty = editor.value !== currentPlanRaw;
      if (currentPlanDirty) {
        setPlanSaveStatus('Unsaved changes', 'dirty');
      } else {
        setPlanSaveStatus('', '');
      }
    });
    editor.addEventListener('blur', () => {
      if (currentPlanDirty) {
        autosaveCurrentPlan();
      }
    });
  }
  if (approveButton) {
    approveButton.addEventListener('click', async () => {
      approveButton.disabled = true;
      approveButton.textContent = 'Approving...';
      try {
        if (!(await autosaveCurrentPlan())) {
          approveButton.disabled = false;
          approveButton.textContent = 'Approve Plan';
          return;
        }
        const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/plan/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
          const issue = await readApiError(response);
          throw new Error(issue.error || 'Failed to approve plan');
        }
        await refreshCurrentTaskAndShowActivity();
      } catch (error) {
        console.error('Plan approve failed:', error);
        showPlanActionError(error.message || 'Failed to approve plan');
        approveButton.disabled = false;
        approveButton.textContent = 'Approve Plan';
      }
    });
  }
  const recallButton = document.getElementById('plan-recall-btn');
  if (recallButton) {
    recallButton.addEventListener('click', async () => {
      recallButton.disabled = true;
      recallButton.textContent = 'Recalling...';
      try {
        const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/plan/recall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
          const issue = await readApiError(response);
          throw new Error(issue.error || 'Failed to recall plan');
        }
        await refreshCurrentTaskAndShowPlan();
      } catch (error) {
        console.error('Plan recall failed:', error);
        showPlanActionError(error.message || 'Failed to recall plan');
        recallButton.disabled = false;
        recallButton.textContent = 'Recall Plan';
      }
    });
  }
  if (!approved) {
    bindDraftPlanControls(currentTask);
    const draftRunId = currentTask?.runtime?.activeDraftPlanRunId;
    if (draftRunId && drafting) {
      connectDraftSocket(draftRunId);
      const stopBtn = document.getElementById('plan-draft-stop-btn');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          stopBtn.disabled = true;
          stopBtn.textContent = 'Stopping...';
          try {
            const response = await fetch(`/api/runs/${draftRunId}/stop`, { method: 'POST' });
            if (!response.ok) {
              throw new Error('Failed to stop');
            }
          } catch (err) {
            console.error('Stop draft failed:', err);
            stopBtn.disabled = false;
            stopBtn.textContent = 'Stop';
          }
        });
      }
    } else {
      disconnectDraftSocket();
    }
    const toggleBtn = document.getElementById('plan-request-changes-btn');
    const refinement = document.getElementById('plan-refinement-section');
    if (toggleBtn && refinement) {
      const closeBtn = document.getElementById('plan-refinement-close-btn');
      const agentSelect = document.getElementById('draft-plan-agent');
      const modelSelect = document.getElementById('draft-plan-model');
      const effortSelect = document.getElementById('draft-plan-effort');
      const effortField = document.getElementById('draft-plan-effort-field');
      const modeSelect = document.getElementById('draft-plan-mode');
      const input = document.getElementById('draft-plan-input');
      if (input) {
        input.addEventListener('input', () => {
          planRefinementDraftInput = input.value;
        });
      }
      const syncToggle = () => {
        const open = !refinement.classList.contains('hidden');
        toggleBtn.innerHTML = `<span class="plan-action-icon">&#9998;</span><span>${open ? 'Submit Changes' : 'Request Changes'}</span>`;
        toggleBtn.classList.toggle('plan-request-changes-btn-active', open);
        toggleBtn.disabled = open && drafting;
        if (approveButton) {
          approveButton.disabled = open || planState === 'todo' || !plan.raw?.trim();
        }
      };
      syncToggle();
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          planRefinementOpen = false;
          refinement.classList.add('hidden');
          syncToggle();
        });
      }
      toggleBtn.addEventListener('click', async () => {
        if (refinement.classList.contains('hidden')) {
          planRefinementOpen = true;
          refinement.classList.remove('hidden');
          syncToggle();
          return;
        }
        const feedback = input?.value?.trim() || '';
        if (!feedback) {
          input?.focus();
          return;
        }
        if (!(await autosaveCurrentPlan())) {
          return;
        }
        const selection = syncPhaseSelectControls(agentSelect, modelSelect, effortSelect, effortField);
        toggleBtn.disabled = true;
        toggleBtn.textContent = 'Drafting...';
        try {
          const response = await fetch(`/api/tasks/${currentTask.boardColumn}/${currentTask.filename}/plan-draft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              additionalInput: feedback,
              agentId: selection.agentId,
              model: selection.model,
              effort: selection.effort,
              draftPlanMode: modeSelect?.value || 'fast_refine',
              ...secondOpinionPayload(),
            }),
          });
          if (!response.ok) {
            const issue = await readApiError(response);
            throw new Error(issue.error || 'Failed to draft plan');
          }
          const payload = await response.json();
          currentPlanPath = payload.planPath || currentPlanPath;
          currentPlanDirty = false;
          resetPlanRefinementState();
          await refreshCurrentTask(true);
        } catch (error) {
          console.error('Plan draft failed:', error);
          toggleBtn.disabled = false;
          syncToggle();
        }
      });
    }
  }
}

async function openPlan(planPath) {
  taskContent.innerHTML = '<p>Loading plan...</p>';
  try {
    const response = await fetch(`/api/plans/${planPath}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const plan = await response.json();
    let editing = false;

    const renderPlan = () => {
      taskContent.innerHTML = `
        <div class="plan-toolbar">
          <button class="plan-back" id="plan-back">Back to task</button>
          <button class="plan-edit-btn" id="plan-edit-btn">${editing ? 'Preview' : 'Edit'}</button>
        </div>
        <div class="detail-section-label" style="margin-bottom: 0.75rem;">${esc(plan.path)}</div>
        ${editing
          ? `<textarea class="plan-editor" id="plan-editor">${esc(plan.raw)}</textarea>`
          : `<div class="plan-content">${plan.html}</div>`
        }
      `;

      document.getElementById('plan-back').addEventListener('click', async () => {
        if (editing) {
          const editor = document.getElementById('plan-editor');
          if (editor.value !== plan.raw) {
            await savePlan(plan.path, editor.value);
            plan.raw = editor.value;
            plan.html = marked.parse(editor.value);
          }
        }
        if (currentTask) {
          openDetail(currentTask, { preserveInteraction: true });
        }
      });

      document.getElementById('plan-edit-btn').addEventListener('click', async () => {
        if (editing) {
          const editor = document.getElementById('plan-editor');
          if (editor.value !== plan.raw) {
            await savePlan(plan.path, editor.value);
            plan.raw = editor.value;
            plan.html = marked.parse(editor.value);
          }
        }
        editing = !editing;
        renderPlan();
      });
    };

    renderPlan();
  } catch (error) {
    console.error('Plan load failed:', error);
    taskContent.innerHTML = `
      <button class="plan-back" id="plan-back">Back to task</button>
      <p>Failed to load plan: ${esc(error.message)}</p>
    `;
    document.getElementById('plan-back').addEventListener('click', () => {
      if (currentTask) {
        openDetail(currentTask, { preserveInteraction: true });
      }
    });
  }
}

async function savePlan(planPath, content) {
  const response = await fetch('/api/plans/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: planPath, content }),
  });
  if (!response.ok) {
    throw new Error('plan save failed');
  }
}

async function loadArchive(refetch = true) {
  if (refetch) {
    const response = await fetch('/api/tasks/archived');
    lastArchiveData = await response.json();
  }

  const tasks = lastArchiveData || [];
  archiveView.innerHTML = '';

  const archivePills = LABEL_OPTIONS
    .map((label) => {
      const active = archiveFilter.includes(label);
      return `<button class="filter-pill label-${label}${active ? ' filter-pill-active' : ''}" data-label="${label}">${label}</button>`;
    })
    .join('');

  const sortLabel = archiveSort === 'newest' ? 'Newest' : 'Oldest';
  archiveView.insertAdjacentHTML('beforeend', `
    <div class="archive-header">
      <span class="column-title">ARCHIVED TASKS</span>
      <button class="toolbar-sort" id="archive-sort">${sortLabel}</button>
    </div>
    <div class="column-toolbar archive-toolbar">
      <div class="filter-pills">${archivePills}</div>
    </div>
  `);

  let filtered = tasks;
  if (archiveFilter.length > 0) {
    filtered = filtered.filter((task) => archiveFilter.every((label) => (task.labels || []).includes(label)));
  }

  filtered = [...filtered].sort((left, right) => {
    if (archiveSort === 'oldest') {
      return (left.creation_date || '').localeCompare(right.creation_date || '');
    }
    return (right.creation_date || '').localeCompare(left.creation_date || '');
  });

  if (filtered.length === 0) {
    archiveView.insertAdjacentHTML('beforeend', '<div class="archive-empty">No archived tasks.</div>');
  } else {
    const list = document.createElement('div');
    list.className = 'archive-list';
    filtered.forEach((task) => {
      const card = renderCard(task);
      card.classList.add('archive-card');
      list.appendChild(card);
    });
    archiveView.appendChild(list);
  }

  archiveView.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const label = pill.dataset.label;
      const index = archiveFilter.indexOf(label);
      if (index >= 0) {
        archiveFilter.splice(index, 1);
      } else {
        archiveFilter.push(label);
      }
      loadArchive(false);
    });
  });

  document.getElementById('archive-sort').addEventListener('click', () => {
    archiveSort = archiveSort === 'newest' ? 'oldest' : 'newest';
    loadArchive(false);
  });
}

function stopBoardPolling() {
  if (boardPollTimer) {
    clearInterval(boardPollTimer);
    boardPollTimer = null;
  }
}

function stopTaskPolling() {
  if (taskPollTimer) {
    clearInterval(taskPollTimer);
    taskPollTimer = null;
  }
}

function startBoardPolling() {
  stopBoardPolling();
  boardPollTimer = setInterval(() => {
    if (!taskView.classList.contains('hidden')) {
      return;
    }
    fetchBoardData()
      .then((data) => renderBoard(data))
      .catch((error) => console.error('Board refresh failed:', error));
  }, 5000);
}

function startTaskPolling() {
  stopTaskPolling();
  taskPollTimer = setInterval(() => {
    refreshCurrentTask().catch((error) => console.error('Task refresh failed:', error));
  }, 4000);
}

function closeTask() {
  stopTaskPolling();
  resetInteractionPanel();
  clearTransientPhaseValidation();
  taskView.classList.add('hidden');
  taskContent.innerHTML = '';
  interactionHeader.innerHTML = `
    <div>
      <div class="detail-section-label">Agent Transcript</div>
      <div class="interaction-title">No Active Task</div>
      <div class="interaction-subtitle">Open a task to inspect its run transcript.</div>
    </div>
  `;
  currentTask = null;
}

function isNearBottom(element) {
  const threshold = 48;
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function backToBoard() {
  closeTask();
  board.classList.remove('hidden');
  archiveView.classList.add('hidden');
  navBoard.classList.add('active');
  navArchive.classList.remove('active');
  history.replaceState(null, '', window.location.pathname);
  startBoardPolling();
  if (!lastBoardData) {
    initBoard().catch((error) => console.error('Board init failed:', error));
  }
}

function showView(view) {
  if (view === 'board') {
    backToBoard();
    return;
  }

  closeTask();
  stopBoardPolling();
  board.classList.add('hidden');
  archiveView.classList.remove('hidden');
  navBoard.classList.remove('active');
  navArchive.classList.add('active');
  history.replaceState(null, '', '#archive');
  loadArchive().catch((error) => console.error('Archive load failed:', error));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !taskView.classList.contains('hidden')) {
    backToBoard();
  }
});

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function startup() {
  await loadAgents();

  const hash = window.location.hash;
  if (hash === '#archive') {
    showView('archive');
    return;
  }

  const taskMatch = hash.match(/^#task\/(todo|doing|review|done)\/(.+)$/);
  if (taskMatch) {
    const [, column, filename] = taskMatch;
    const data = await fetchBoardData();
    renderBoard(data);
    const task = findTaskByFilename(data, filename);
    if (task) {
      openDetail(task);
      return;
    }
  }

  await initBoard();
  startBoardPolling();
}

window.addEventListener('hashchange', () => {
  startup().catch((error) => console.error('Hashchange startup failed:', error));
});

startup().catch((error) => console.error('Startup failed:', error));
