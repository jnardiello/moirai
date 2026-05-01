const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const pty = require('node-pty');
const { marked } = require('marked');
const { WebSocketServer } = require('ws');

const backlog = require('./lib/backlog');
const {
  DEFAULT_CONFIG,
  loadBoardConfig,
  normalizeBoardConfig,
  saveDiscoveredAgentCatalog,
} = require('./lib/config');
const { discoverAgentCatalog, supportedAgents, buildAgentCommand } = require('./lib/agents');
const { PHASE_KEYS, normalizePhaseConfig, getPhaseSelection } = require('./lib/phase-config');
const {
  appendPlanFeedbackEntry,
  extractDelimitedBlock,
  getPrimaryPlanRef,
  markPlanExecuted,
  normalizeMarkdown,
  parsePlanFeedbackHistory,
  readPlanFile,
  splitPlanFeedbackHistory,
  upsertAgentPlanAppendix,
  writePlanFile,
} = require('./lib/plan-files');
const { createTranscriptParser, createClaudeStreamJsonParser } = require('./lib/run-transcript');
const {
  detectProject,
  doctorProject,
  initializeProject,
  suggestRepositories,
} = require('./lib/project');

const app = express();
app.use(express.json());

const APP_ROOT = __dirname;
const PROJECT_ROOT = path.resolve(process.env.MOIRAI_PROJECT_ROOT || process.cwd());
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
let setupMode = process.env.MOIRAI_SETUP_MODE === '1'
  || detectProject(PROJECT_ROOT).recommendedAction !== 'open';
let CONFIG;
try {
  CONFIG = loadBoardConfig(PROJECT_ROOT);
} catch {
  CONFIG = normalizeBoardConfig(PROJECT_ROOT, DEFAULT_CONFIG);
}
let BACKLOG_ROOT = CONFIG.repos.backlog || CONFIG.boardRoot || PROJECT_ROOT;
const DISCOVERED_AGENT_CONFIG = discoverAgentCatalog(CONFIG);
if (!setupMode) {
  saveDiscoveredAgentCatalog(PROJECT_ROOT, DISCOVERED_AGENT_CONFIG);
}
CONFIG.agents = {
  ...CONFIG.agents,
  ...DISCOVERED_AGENT_CONFIG,
};
const AGENTS = supportedAgents(CONFIG);
const AGENT_IDS = new Set(AGENTS.map((agent) => agent.id));
const ACTIVE_RUNS = new Map();
const TASK_TERMINALS = new Map();

const PHASE_LABELS = {
  draft_plan: 'Draft Plan',
  planning: 'Agent Plan',
  implementing: 'Implementing',
  validate: 'Validate',
};

function primaryPhaseSelection(phaseConfig) {
  return getPhaseSelection(phaseConfig, 'planning');
}

if (!setupMode) {
  ensureRuntimeDirs();
  cleanupStaleRuns();
}

function ensureRuntimeDirs() {
  ensureDir(CONFIG.runtimeDir);
  ensureDir(CONFIG.worktreeRoot);
  ensureDir(runtimeTasksDir());
  ensureDir(runtimeRunsDir());
}

// On startup, mark any stale running/queued/stopping/awaiting_input runs as interrupted.
function cleanupStaleRuns() {
  const STALE_STATUSES = new Set(['running', 'queued', 'stopping', 'awaiting_input']);
  try {
    const runDirs = fs.readdirSync(runtimeRunsDir());
    for (const runId of runDirs) {
      const metaPath = runMetaPath(runId);
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta && STALE_STATUSES.has(meta.status)) {
          meta.status = 'interrupted';
          meta.finishedAt = meta.finishedAt || new Date().toISOString();
          meta.updatedAt = new Date().toISOString();
          meta.errorMessage = meta.errorMessage || 'Server restarted while run was active.';
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }
      } catch {
        // skip corrupt meta files
      }
    }
  } catch {
    // runs dir may not exist yet
  }
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(APP_ROOT, 'public', setupMode ? 'wizard.html' : 'index.html'));
});

app.use(express.static(path.join(APP_ROOT, 'public'), { index: false }));

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runtimeTasksDir() {
  return path.join(CONFIG.runtimeDir, 'tasks');
}

function runtimeRunsDir() {
  return path.join(CONFIG.runtimeDir, 'runs');
}

function taskRuntimePath(taskId) {
  return path.join(runtimeTasksDir(), `${encodeURIComponent(taskId)}.json`);
}

function runDirectory(runId) {
  return path.join(runtimeRunsDir(), runId);
}

function runMetaPath(runId) {
  return path.join(runDirectory(runId), 'meta.json');
}

function runTerminalPath(runId) {
  return path.join(runDirectory(runId), 'terminal.log');
}

function runEventsPath(runId) {
  return path.join(runDirectory(runId), 'events.jsonl');
}

function runArtifactPath(runId, name) {
  return path.join(runDirectory(runId), `${name}.log`);
}

function appendTerminalHistory(session, text) {
  if (!text) {
    return;
  }

  const maxChars = 250000;
  session.history += text;
  if (session.history.length > maxChars) {
    session.history = session.history.slice(session.history.length - maxChars);
  }
  session.updatedAt = new Date().toISOString();
}

function resolveSafeTerminalCwd(cwd) {
  let safeCwd = cwd || BACKLOG_ROOT;
  try {
    if (!fs.existsSync(safeCwd) || !fs.statSync(safeCwd).isDirectory()) {
      safeCwd = BACKLOG_ROOT;
    }
  } catch {
    safeCwd = BACKLOG_ROOT;
  }
  return safeCwd;
}

function createTaskTerminalSession(taskId, cwd) {
  const safeCwd = resolveSafeTerminalCwd(cwd);
  const shell = process.env.SHELL || '/bin/zsh';
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: safeCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const session = {
    taskId,
    cwd: safeCwd,
    term,
    clients: new Set(),
    history: '',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  term.onData((data) => {
    appendTerminalHistory(session, data);
    for (const client of session.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(data);
        } catch {
          // ignore broken sockets
        }
      }
    }
  });

  term.onExit(() => {
    TASK_TERMINALS.delete(taskId);
    for (const client of session.clients) {
      try {
        client.close();
      } catch {
        // ignore close failures
      }
    }
    session.clients.clear();
  });

  TASK_TERMINALS.set(taskId, session);
  return session;
}

function getOrCreateTaskTerminalSession(taskId, cwd) {
  const existing = TASK_TERMINALS.get(taskId);
  if (existing) {
    return existing;
  }
  return createTaskTerminalSession(taskId, cwd);
}

function destroyTaskTerminalSession(taskId) {
  const session = TASK_TERMINALS.get(taskId);
  if (!session) {
    return;
  }
  TASK_TERMINALS.delete(taskId);
  for (const client of session.clients) {
    try {
      client.close();
    } catch {
      // ignore close failures
    }
  }
  session.clients.clear();
  try {
    session.term.kill();
  } catch {
    // ignore kill failures
  }
}

function safeReadJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function safeReadJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function safeReadText(filePath) {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function appendRawLog(runState, text, artifactName = null) {
  if (!text) {
    return;
  }

  ensureDir(runDirectory(runState.id));
  fs.appendFileSync(runTerminalPath(runState.id), text, 'utf-8');
  if (artifactName) {
    fs.appendFileSync(runArtifactPath(runState.id, artifactName), text, 'utf-8');
    if (!runState.phaseArtifacts.includes(artifactName)) {
      runState.phaseArtifacts.push(artifactName);
    }
  }
}

function getTaskRuntime(taskId) {
  const stored = safeReadJson(taskRuntimePath(taskId), {});
  const runtime = {
    taskId,
    assignedAgent: null,
    activeRunId: null,
    run: null,
    activeDraftPlanRunId: null,
    draftPlanRun: null,
    draftPlanConfig: null,
    draftPlanMode: null,
    secondOpinionConfig: null,
    planState: null,
    planApprovedAt: null,
    planApprovedBy: null,
    planGenerationIteration: 0,
    executionContext: null,
    model: null,
    effort: null,
    phaseConfig: null,
    updatedAt: null,
    ...stored,
  };

  runtime.phaseConfig = normalizePhaseConfig(runtime.phaseConfig, {
    assignedAgent: runtime.assignedAgent,
    model: runtime.model,
    effort: runtime.effort,
  });

  for (const phaseKey of PHASE_KEYS) {
    const selection = getPhaseSelection(runtime.phaseConfig, phaseKey);
    if (!selection.agentId) {
      continue;
    }
    const agent = getAgentById(selection.agentId);
    if (!agent) {
      continue;
    }
    runtime.phaseConfig[phaseKey] = normalizeSelectionForAgent(agent, selection);
  }

  const planningSelection = primaryPhaseSelection(runtime.phaseConfig);
  runtime.assignedAgent = planningSelection.agentId || null;
  runtime.model = planningSelection.model || null;
  runtime.effort = planningSelection.effort || null;
  runtime.draftPlanConfig = normalizeDraftPlanConfig(runtime);
  runtime.draftPlanMode = normalizeDraftPlanMode(runtime.draftPlanMode);
  runtime.secondOpinionConfig = normalizeSecondOpinionConfig(runtime);

  if (runtime.activeRunId && !ACTIVE_RUNS.has(runtime.activeRunId)) {
    runtime.activeRunId = null;
    const staleStatuses = ['running', 'queued', 'stopping', 'awaiting_input'];
    if (runtime.run && staleStatuses.includes(runtime.run.status)) {
      runtime.run = {
        ...runtime.run,
        status: 'interrupted',
        errorMessage: runtime.run.errorMessage || 'Server restarted while run was active.',
      };
    }
  }
  if (runtime.activeDraftPlanRunId && !ACTIVE_RUNS.has(runtime.activeDraftPlanRunId)) {
    runtime.activeDraftPlanRunId = null;
    const staleStatuses = ['running', 'queued', 'stopping', 'awaiting_input'];
    if (runtime.draftPlanRun && staleStatuses.includes(runtime.draftPlanRun.status)) {
      runtime.draftPlanRun = {
        ...runtime.draftPlanRun,
        status: 'interrupted',
        errorMessage: runtime.draftPlanRun.errorMessage || 'Server restarted while plan drafting was active.',
      };
    }
  }

  return runtime;
}

function isResumableRun(run) {
  if (!run) {
    return false;
  }
  if (!run.executionContext?.primaryWorktreePath) {
    return false;
  }
  return ['stopped', 'interrupted', 'failed', 'awaiting_input'].includes(run.status);
}

function saveTaskRuntime(taskId, runtime) {
  const phaseConfig = normalizePhaseConfig(runtime.phaseConfig, {
    assignedAgent: runtime.assignedAgent,
    model: runtime.model,
    effort: runtime.effort,
  });
  const primarySelection = primaryPhaseSelection(phaseConfig);

  writeJson(taskRuntimePath(taskId), {
    taskId,
    assignedAgent: runtime.assignedAgent || primarySelection.agentId || null,
    model: runtime.model || primarySelection.model || null,
    effort: runtime.effort || primarySelection.effort || null,
    phaseConfig,
    activeRunId: runtime.activeRunId || null,
    run: runtime.run || null,
    activeDraftPlanRunId: runtime.activeDraftPlanRunId || null,
    draftPlanRun: runtime.draftPlanRun || null,
    draftPlanConfig: runtime.draftPlanConfig || normalizeDraftPlanConfig({ ...runtime, phaseConfig }),
    draftPlanMode: normalizeDraftPlanMode(runtime.draftPlanMode),
    secondOpinionConfig: runtime.secondOpinionConfig || normalizeSecondOpinionConfig({ ...runtime, phaseConfig }),
    planState: runtime.planState || null,
    planApprovedAt: runtime.planApprovedAt || null,
    planApprovedBy: runtime.planApprovedBy || null,
    planGenerationIteration: runtime.planGenerationIteration || 0,
    executionContext: runtime.executionContext || null,
    updatedAt: new Date().toISOString(),
  });
}

function summarizeRun(runState) {
  return {
    id: runState.id,
    runKind: runState.runKind || 'pipeline',
    taskId: runState.taskId,
    agentId: runState.agentId,
    status: runState.status,
    phase: runState.phase,
    phaseLabel: PHASE_LABELS[runState.phase] || runState.phase,
    waitingForInput: Boolean(runState.waitingForInput),
    pendingInputRequest: runState.pendingInputRequest || null,
    startedAt: runState.startedAt,
    updatedAt: runState.updatedAt,
    finishedAt: runState.finishedAt || null,
    errorMessage: runState.errorMessage || null,
    reviewAttempts: runState.reviewAttempts || 0,
    iteration: runState.iteration || 1,
    reviewState: runState.reviewState || null,
    latestReviewerFeedback: runState.latestReviewerFeedback || null,
    reviewFeedbackHistory: runState.reviewFeedbackHistory || [],
    validationStatus: runState.validationStatus || null,
    docsStatus: runState.docsStatus || null,
    phaseSelection: runState.phaseSelection || null,
    primaryPlanRef: runState.primaryPlanRef || null,
    draftPlanMode: runState.draftPlanMode || null,
    secondOpinionEnabled: Boolean(runState.secondOpinionEnabled),
    secondOpinionConfig: runState.secondOpinionConfig || null,
    artifacts: runState.artifacts || {},
    artifactHistory: runState.artifactHistory || {},
    executionContext: runState.executionContext || null,
    inputHistory: runState.inputHistory || [],
    additionalInput: runState.additionalInput || null,
  };
}

function broadcastMessage(runState, payload) {
  const serialized = JSON.stringify(payload);
  for (const client of runState.clients) {
    if (client.readyState === 1) {
      try {
        client.send(serialized);
      } catch {
        // ignore socket write failures
      }
    }
  }
}

function persistRunState(runState) {
  ensureDir(runDirectory(runState.id));
  writeJson(runMetaPath(runState.id), {
    ...summarizeRun(runState),
    promptArtifacts: runState.promptArtifacts || [],
    phaseArtifacts: runState.phaseArtifacts || [],
  });

  const runtime = getTaskRuntime(runState.taskId);
  if (runState.runKind === 'draft_plan') {
    runtime.activeDraftPlanRunId = ACTIVE_RUNS.has(runState.id) ? runState.id : null;
    runtime.draftPlanRun = summarizeRun(runState);
  } else {
    runtime.assignedAgent = runState.agentId;
    runtime.activeRunId = ACTIVE_RUNS.has(runState.id) ? runState.id : null;
    runtime.run = summarizeRun(runState);
    runtime.executionContext = runState.executionContext || runtime.executionContext || null;
  }
  saveTaskRuntime(runState.taskId, runtime);
}

function setRunState(runState, patch) {
  Object.assign(runState, patch);
  runState.updatedAt = new Date().toISOString();
  persistRunState(runState);
  broadcastMessage(runState, {
    type: 'state',
    run: summarizeRun(runState),
  });
}

function appendEvent(runState, type, payload = {}) {
  const runner = runState.phaseSelection?.agentId
    ? {
      agentId: runState.phaseSelection.agentId,
      model: runState.phaseSelection.model || null,
      effort: runState.phaseSelection.effort || null,
    }
    : null;

  const event = {
    id: `${runState.id}:${++runState.eventSequence}`,
    timestamp: new Date().toISOString(),
    phase: runState.phase,
    type,
    runner,
    ...payload,
  };

  appendJsonLine(runEventsPath(runState.id), event);
  broadcastMessage(runState, {
    type: 'event',
    event,
    run: summarizeRun(runState),
  });
  return event;
}

function logSystem(runState, message, artifactName = null, type = 'system') {
  appendRawLog(runState, `${message}\n`, artifactName);
  appendEvent(runState, type, { message });
}

function logPhase(runState, phase) {
  appendRawLog(runState, `\n=== ${PHASE_LABELS[phase]} ===\n`, phase);
  appendEvent(runState, 'phase', {
    message: PHASE_LABELS[phase],
    phaseKey: phase,
  });
}

function logCommand(runState, commandString, artifactName = null) {
  appendRawLog(runState, `$ ${commandString}\n`, artifactName);
  appendEvent(runState, 'command', { message: commandString });
}

function taskRuntimeForResponse(taskId) {
  const runtime = getTaskRuntime(taskId);
  const task = findTaskByFilename(taskId);
  const planState = derivePlanState(task, runtime);
  return {
    assignedAgent: runtime.assignedAgent,
    model: runtime.model || null,
    effort: runtime.effort || null,
    phaseConfig: runtime.phaseConfig,
    phaseValidation: collectPhaseValidation(runtime),
    draftPlanConfig: runtime.draftPlanConfig,
    draftPlanMode: normalizeDraftPlanMode(runtime.draftPlanMode),
    secondOpinionConfig: runtime.secondOpinionConfig,
    activeDraftPlanRunId: runtime.activeDraftPlanRunId || null,
    draftPlanRun: runtime.draftPlanRun || null,
    planState,
    planApprovedAt: runtime.planApprovedAt || null,
    planApprovedBy: runtime.planApprovedBy || null,
    planGenerationIteration: runtime.planGenerationIteration || 0,
    activeRunId: runtime.activeRunId,
    run: runtime.run,
    executionContext: runtime.executionContext,
    updatedAt: runtime.updatedAt,
  };
}

function findTaskByFilename(filename) {
  for (const column of backlog.BOARD_COLUMNS) {
    const task = backlog.readTask(BACKLOG_ROOT, column, filename);
    if (task) {
      return task;
    }
  }
  return null;
}

function derivePlanState(task, runtime = {}) {
  if (!task || !Array.isArray(task.plans_files) || task.plans_files.length === 0) {
    return 'todo';
  }
  if (runtime.planState === 'todo') {
    return 'todo';
  }
  if (runtime.planState === 'approved') {
    return 'approved';
  }
  return 'generated';
}

function getAgentById(agentId) {
  return AGENTS.find((agent) => agent.id === agentId) || null;
}

function normalizeStringList(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function normalizeClaudeRuntimeModel(model) {
  if (typeof model !== 'string' || !model.trim()) {
    return null;
  }

  let normalized = model.trim();
  normalized = normalized.replace(/-v\d+$/i, '');
  normalized = normalized.replace(/^claude-(sonnet|opus|haiku)-(\d+)\.(\d+)$/i, 'claude-$1-$2-$3');
  return normalized;
}

function normalizeSelectionForAgent(agent, selection) {
  const nextSelection = {
    agentId: selection.agentId || null,
    model: selection.model || null,
    effort: selection.effort || null,
  };

  if (!agent) {
    return {
      agentId: null,
      model: null,
      effort: null,
    };
  }

  if (agent.id === 'claude' && nextSelection.model) {
    const normalizedModel = normalizeClaudeRuntimeModel(nextSelection.model);
    const familyAlias = normalizedModel?.match(/^claude-(sonnet|opus|haiku)-/i)?.[1]?.toLowerCase() || null;
    const repairCandidates = normalizeStringList([
      normalizedModel,
      familyAlias,
    ]);
    const repairedModel = repairCandidates.find((candidate) => agent.models.includes(candidate));
    nextSelection.model = repairedModel || nextSelection.model;
  }

  if (nextSelection.model && agent.models.length > 0 && !agent.models.includes(nextSelection.model)) {
    nextSelection.model = null;
  }

  const selectedModelConfig = agent.modelCatalog?.find((entry) => entry.slug === nextSelection.model) || null;
  const allowedEfforts = selectedModelConfig?.efforts?.length
    ? selectedModelConfig.efforts
    : (agent.efforts || []);

  if (!agent.supportsEffort || (nextSelection.effort && !allowedEfforts.includes(nextSelection.effort))) {
    nextSelection.effort = null;
  }

  return nextSelection;
}

function preferredDraftPlanSelection() {
  const codex = getAgentById('codex');
  if (codex) {
    if ((codex.models || []).includes('gpt-5.3-codex-spark')) {
      return normalizeSelectionForAgent(codex, {
        agentId: 'codex',
        model: 'gpt-5.3-codex-spark',
        effort: (codex.efforts || []).includes('xhigh') ? 'xhigh' : 'high',
      });
    }
    if ((codex.models || []).includes('gpt-5.4-mini')) {
      return normalizeSelectionForAgent(codex, {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        effort: (codex.efforts || []).includes('medium') ? 'medium' : null,
      });
    }
  }

  return null;
}

function normalizeDraftPlanConfig(runtime = {}) {
  const fallback = primaryPhaseSelection(runtime.phaseConfig || {});
  const source = runtime.draftPlanConfig || {};
  const sourceEmpty = !source.agentId && !source.model && !source.effort;
  const preferred = preferredDraftPlanSelection();
  const baseSelection = sourceEmpty ? (preferred || fallback) : source;
  const selection = {
    agentId: baseSelection.agentId || null,
    model: baseSelection.model || null,
    effort: baseSelection.effort || null,
  };
  const agent = getAgentById(selection.agentId);
  return normalizeSelectionForAgent(agent, selection);
}

function normalizeDraftPlanMode(mode) {
  return mode === 'deep_draft' ? 'deep_draft' : 'fast_refine';
}

function preferredSecondOpinionSelection() {
  const codex = getAgentById('codex');
  if (codex) {
    if ((codex.models || []).includes('gpt-5.4')) {
      return normalizeSelectionForAgent(codex, {
        agentId: 'codex',
        model: 'gpt-5.4',
        effort: (codex.efforts || []).includes('high') ? 'high' : null,
      });
    }
    if ((codex.models || []).includes('gpt-5.3-codex')) {
      return normalizeSelectionForAgent(codex, {
        agentId: 'codex',
        model: 'gpt-5.3-codex',
        effort: (codex.efforts || []).includes('high') ? 'high' : null,
      });
    }
  }
  return preferredDraftPlanSelection();
}

function normalizeSecondOpinionConfig(runtime = {}) {
  const source = runtime.secondOpinionConfig || {};
  const sourceEmpty = !source.agentId && !source.model && !source.effort;
  const selection = sourceEmpty ? preferredSecondOpinionSelection() : source;
  const agent = getAgentById(selection?.agentId);
  return normalizeSelectionForAgent(agent, selection || {});
}

function validateAgentSelection(selection, label) {
  const agent = getAgentById(selection?.agentId);
  if (!agent) {
    return {
      issue: { error: `invalid ${label} agent` },
    };
  }
  const normalized = normalizeSelectionForAgent(agent, selection);
  if (!normalized.agentId) {
    return {
      issue: { error: `invalid ${label} agent` },
    };
  }
  if ((selection.model || null) && !normalized.model) {
    return {
      issue: { error: `invalid ${label} model` },
    };
  }
  if ((selection.effort || null) && !normalized.effort) {
    return {
      issue: { error: `invalid ${label} effort` },
    };
  }
  return { normalized };
}

function buildPhaseValidationIssue(phase, field, message, value) {
  return {
    phase,
    field,
    value: value ?? null,
    error: message,
  };
}

function validatePhaseSelection(phase, selection, options = {}) {
  const requireAgent = Boolean(options.requireAgent);
  const normalized = getPhaseSelection({ [phase]: selection }, phase);
  if (!normalized.agentId) {
    if (requireAgent) {
      return {
        issue: buildPhaseValidationIssue(phase, 'agent', `${PHASE_LABELS[phase]} agent is not configured`, null),
      };
    }
    return { agent: null, selection: normalized, allowedEfforts: [], issue: null };
  }

  if (!AGENT_IDS.has(normalized.agentId)) {
    return {
      issue: buildPhaseValidationIssue(phase, 'agent', `invalid agent for ${PHASE_LABELS[phase]}`, normalized.agentId),
    };
  }

  const agent = getAgentById(normalized.agentId);
  if (normalized.model && agent && agent.models.length > 0 && !agent.models.includes(normalized.model)) {
    return {
      issue: buildPhaseValidationIssue(phase, 'model', `invalid model for ${PHASE_LABELS[phase]}`, normalized.model),
    };
  }

  const selectedModelConfig = agent?.modelCatalog?.find((entry) => entry.slug === normalized.model) || null;
  const allowedEfforts = selectedModelConfig?.efforts?.length
    ? selectedModelConfig.efforts
    : (agent?.efforts || []);

  if (normalized.effort && agent && (!agent.supportsEffort || !allowedEfforts.includes(normalized.effort))) {
    return {
      issue: buildPhaseValidationIssue(phase, 'effort', `invalid effort for ${PHASE_LABELS[phase]}`, normalized.effort),
    };
  }

  return {
    agent,
    selection: normalized,
    allowedEfforts,
    issue: null,
  };
}

function collectPhaseValidation(runtime, options = {}) {
  const validation = {};
  for (const phaseKey of PHASE_KEYS) {
    const result = validatePhaseSelection(phaseKey, getPhaseSelection(runtime.phaseConfig, phaseKey), options);
    validation[phaseKey] = result.issue || null;
  }
  return validation;
}

function enrichTask(task) {
  return {
    ...task,
    runtime: taskRuntimeForResponse(backlog.taskFilenameToId(task.filename)),
  };
}

function loadBoardResponse() {
  const board = backlog.loadBoardTasks(BACKLOG_ROOT);
  const response = {};
  for (const column of backlog.BOARD_COLUMNS) {
    response[column] = (board[column] || []).map(enrichTask);
  }
  return response;
}

function readTaskForBoardColumn(column, filename) {
  const task = backlog.readTask(BACKLOG_ROOT, column, filename);
  return task ? enrichTask(task) : null;
}

function markPlanEditedRequiresApproval(planRef) {
  const boardTasks = backlog.loadBoardTasks(BACKLOG_ROOT);
  const seen = new Set();
  for (const tasks of Object.values(boardTasks)) {
    for (const task of tasks || []) {
      if (seen.has(task.filename) || !(task.plans_files || []).includes(planRef)) {
        continue;
      }
      seen.add(task.filename);
      const taskId = backlog.taskFilenameToId(task.filename);
      const runtime = getTaskRuntime(taskId);
      if (runtime.planState === 'approved') {
        runtime.planState = 'generated';
        runtime.planApprovedAt = null;
        runtime.planApprovedBy = null;
        saveTaskRuntime(taskId, runtime);
      }
    }
  }
}

function getActiveRunOrThrow(runId) {
  const runState = ACTIVE_RUNS.get(runId);
  if (!runState) {
    throw new Error('run not active');
  }
  return runState;
}

function resolveRepoPath(repoName) {
  const repoPath = CONFIG.repos[repoName] || path.resolve(CONFIG.repoBaseDir, repoName);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`repository path not found for ${repoName}: ${repoPath}`);
  }
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    throw new Error(`repository ${repoName} is not a git repository: ${repoPath}`);
  }
  return repoPath;
}

function branchSlug(task) {
  const base = task.filename.replace(/\.md$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `task/${base}`;
}

function readGitInstructions(repoPath) {
  const instructionsPath = path.join(repoPath, 'AGENTS.md');
  if (!fs.existsSync(instructionsPath)) {
    return null;
  }
  return {
    path: instructionsPath,
    content: fs.readFileSync(instructionsPath, 'utf-8'),
  };
}

function trimForPrompt(text, maxLength = 16000) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n\n[truncated]`;
}

function buildHumanInputHistory(runState) {
  if (!runState.inputHistory?.length) {
    return 'None.';
  }

  return runState.inputHistory
    .map((entry) => `- ${entry.request.prompt}\n  Answer: ${entry.answer}`)
    .join('\n');
}

function buildPromptContext(runState, task) {
  const taskPath = path.join(BACKLOG_ROOT, 'todos', task.storageColumn, task.filename);
  const taskMarkdown = safeReadText(taskPath);
  const plans = (task.plans_files || []).map((planRef) => ({
    path: path.join(BACKLOG_ROOT, planRef),
    ref: planRef,
    content: safeReadText(path.join(BACKLOG_ROOT, planRef)),
  }));
  const backlogInstructions = safeReadText(path.join(BACKLOG_ROOT, 'AGENTS.md'));
  const repoInstructions = (runState.executionContext?.repos || [])
    .map((repoContext) => ({
      repoName: repoContext.repoName,
      worktreePath: repoContext.worktreePath,
      instructions: readGitInstructions(repoContext.repoRoot),
    }));

  return {
    taskPath,
    taskMarkdown,
    plans,
    backlogInstructions,
    repoInstructions,
  };
}

function buildClaudePrompt(runState, task, phase, extra = {}) {
  const context = buildPromptContext(runState, task);
  const primaryPlanRef = extra.primaryPlanRef || runState.primaryPlanRef || (task.plans_files || [])[0] || 'unknown';
  const primaryPlan = context.plans.find((plan) => plan.ref === primaryPlanRef) || context.plans[0] || null;
  const repoSummary = (runState.executionContext?.repos || [])
    .map((repoContext) => `- ${repoContext.repoName}: ${repoContext.worktreePath}`)
    .join('\n');
  const reviewerFeedbackSection = runState.latestReviewerFeedback && phase === 'planning'
    ? `\n## Reviewer Feedback To Address\n${trimForPrompt(runState.latestReviewerFeedback, 4000)}\n`
    : '';

  const compactRules = [
    '## Operating Rules',
    '- Stay inside the assigned worktree and branch.',
    '- Follow the primary linked plan as the execution contract.',
    '- Use `MOIRAI_UI_NOTE`, `MOIRAI_UI_ACTION`, `MOIRAI_UI_SECTION`, and status markers exactly as instructed.',
    '- Do not use a full-screen terminal UI and do not ask interactive questions outside the `MOIRAI_UI_REQUEST_INPUT` block.',
    '- Respect repository-approved validation workflows when tests are required.',
    '- Keep repository architecture boundaries intact and do not expose secrets or sensitive data.',
  ].join('\n');

  const phaseInstructions = {
    planning: [
      'Create the agent execution plan for this task before coding.',
      '- Read the task and primary linked plan, treating the approved plan as fixed human-authored intent.',
      '- Do not rewrite or replace the linked plan.',
      '- Turn the approved plan into a structured, actionable TODO list for the implementing agent.',
      '- Emit only the agent TODO list inside `MOIRAI_AGENT_PLAN_BEGIN` / `MOIRAI_AGENT_PLAN_END`.',
      '- End with `MOIRAI_AGENT_PLAN_STATUS: ready`.',
    ].join('\n'),
    implementing: [
      'Implement the task across the available worktrees.',
      '- Treat the approved plan and latest Agent Plan appendix as the execution contract.',
      '- Report visible progress with `MOIRAI_UI_NOTE` or `MOIRAI_UI_ACTION`.',
      '- End with `MOIRAI_IMPLEMENTATION_STATUS: complete` or `MOIRAI_IMPLEMENTATION_STATUS: blocked`.',
    ].join('\n'),
    validate: [
      'Validate the implemented feature before review.',
      '- Run the required backend automated test workflow.',
      '- Update relevant docs if needed.',
      '- Emit `MOIRAI_VALIDATE_SUMMARY_BEGIN` / `MOIRAI_VALIDATE_SUMMARY_END`.',
      '- Emit `MOIRAI_MANUAL_TEST_BEGIN` / `MOIRAI_MANUAL_TEST_END`.',
      '- End with `MOIRAI_DOCS_STATUS: updated|none` and `MOIRAI_VALIDATE_STATUS: pass|fail|blocked`.',
    ].join('\n'),
  };

  const conciseTask = [
    `Title: ${task.title || 'Untitled task'}`,
    task.main_goal ? `Goal: ${task.main_goal}` : null,
    task.short_description ? `Description: ${task.short_description}` : null,
    task.labels?.length ? `Labels: ${task.labels.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const compactPlan = trimForPrompt(primaryPlan?.content || 'No linked plan content found.', 6000);

  const repoRules = [
    '## Repo Rules Summary',
    '- Use the existing worktree and task branch only.',
    '- Keep repository architecture boundaries intact.',
    '- Use repository-approved validation workflows when tests are required.',
    '- Update relevant docs when behavior changes.',
  ].join('\n');

  return `You are the assigned ${runState.agentId} coding agent for backlog task "${task.title}".\n\n## Current Phase\n${PHASE_LABELS[phase]}\n\n## Iteration\n${runState.iteration || 1}\n\n${compactRules}\n\n## Phase Instructions\n${phaseInstructions[phase]}${phase === 'validate' ? '\n- Explain what changed in response to the latest reviewer feedback before finishing validation.' : ''}\n\n## Human Input History\n${buildHumanInputHistory(runState)}\n${reviewerFeedbackSection}## Workspace\nPrimary worktree: ${runState.executionContext?.primaryWorktreePath || 'unknown'}\nBranch: ${runState.executionContext?.branchName || 'unknown'}\n\n## Repositories\n${repoSummary}\n\n## Task Summary\n${conciseTask}\n\n## Primary Linked Plan\n${primaryPlanRef}\n\n${compactPlan}\n\n${repoRules}\n`;
}

function buildPhasePrompt(runState, task, phase, extra = {}) {
  if (runState.agentId === 'claude') {
    return buildClaudePrompt(runState, task, phase, extra);
  }

  const context = buildPromptContext(runState, task);
  const repoSummary = (runState.executionContext?.repos || [])
    .map((repoContext) => `- ${repoContext.repoName}: ${repoContext.worktreePath}`)
    .join('\n');
  const planSummary = context.plans
    .map((plan) => `## ${plan.ref}\n\n${trimForPrompt(plan.content, 20000)}`)
    .join('\n\n');
  const repoInstructions = context.repoInstructions
    .map((repo) => {
      if (!repo.instructions) {
        return `## ${repo.repoName}\nNo repo-local AGENTS.md found.`;
      }
      return `## ${repo.repoName}\nPath: ${repo.instructions.path}\n\n${trimForPrompt(repo.instructions.content, 12000)}`;
    })
    .join('\n\n');

  const protocolBlock = [
    '## UI Transcript Protocol',
    '- Do not use a full-screen terminal UI.',
    '- Print short progress updates as plain text.',
    '- Use `MOIRAI_UI_NOTE: <message>` for narrative progress.',
    '- Use `MOIRAI_UI_ACTION: <message>` for concrete actions you are taking.',
    '- Use `MOIRAI_UI_SECTION: plan|implementation|validate` to mark topic changes when useful.',
    '- If you need human input, do not ask interactively. Instead print exactly:',
    '  MOIRAI_UI_REQUEST_INPUT_BEGIN',
    '  {"request_id":"example-id","kind":"text","prompt":"example question","choices":["optional","choices"]}',
    '  MOIRAI_UI_REQUEST_INPUT_END',
    '- After printing an input request block, exit immediately.',
  ].join('\n');

  const phaseInstructions = {
    planning: [
      'Create the agent execution plan for this task before coding.',
      '- Read the backlog task and linked plan files.',
      '- You are already working on the dedicated feature branch and worktree created by the orchestrator.',
      '- Treat the approved linked plan as fixed human-authored intent. Do not rewrite or replace it.',
      '- Inspect the implementation repo as needed to turn the approved plan into implementation-ready agent TODOs.',
      '- Explain Agent Plan progress using `MOIRAI_UI_NOTE` or `MOIRAI_UI_ACTION` lines.',
      '- Emit the structured agent TODO list inside:',
      '  MOIRAI_AGENT_PLAN_BEGIN',
      '  <structured agent todo list>',
      '  MOIRAI_AGENT_PLAN_END',
      '- The agent TODO list must be concrete enough for the Implementing phase: files/areas to inspect, implementation steps, tests, docs, validation, and risk checks.',
      '- End with the exact line: MOIRAI_AGENT_PLAN_STATUS: ready',
      '- Exit immediately after Agent Plan is complete.',
    ].join('\n'),
    implementing: [
      'Implement the task across the available worktrees.',
      '- The approved linked plan plus the latest Agent Plan appendix is now the execution contract. Follow it exactly.',
      '- Work in the existing feature worktree and branch only.',
      '- Explain the implementation progress using `MOIRAI_UI_NOTE` or `MOIRAI_UI_ACTION` lines.',
      '- If human input is needed, emit a `MOIRAI_UI_REQUEST_INPUT` block and exit.',
      '- When implementation is complete, print the exact line: MOIRAI_IMPLEMENTATION_STATUS: complete',
      '- If blocked, print the exact line: MOIRAI_IMPLEMENTATION_STATUS: blocked and explain why.',
      '- Exit immediately after Implementing is complete.',
    ].join('\n'),
    validate: [
      'Validate the implemented feature before review.',
      '- Execute all backend automated tests using the repository-approved workflow.',
      '- Update all relevant documentation in the implementation repository.',
      '- Explain validation progress using `MOIRAI_UI_NOTE` or `MOIRAI_UI_ACTION` lines.',
      '- If human input is needed, emit a `MOIRAI_UI_REQUEST_INPUT` block and exit.',
      '- Emit a validation summary inside:',
      '  MOIRAI_VALIDATE_SUMMARY_BEGIN',
      '  <markdown summary>',
      '  MOIRAI_VALIDATE_SUMMARY_END',
      '- Emit detailed manual test instructions inside:',
      '  MOIRAI_MANUAL_TEST_BEGIN',
      '  <markdown instructions>',
      '  MOIRAI_MANUAL_TEST_END',
      '- Report documentation status with `MOIRAI_DOCS_STATUS: updated` or `MOIRAI_DOCS_STATUS: none`.',
      '- End with the exact line: MOIRAI_VALIDATE_STATUS: pass',
      '- If blocked, end with the exact line: MOIRAI_VALIDATE_STATUS: blocked and explain why.',
      '- If validation fails, end with the exact line: MOIRAI_VALIDATE_STATUS: fail and explain why.',
      '- Exit immediately after Validate is complete.',
    ].join('\n'),
  };

  const primaryPlanRef = extra.primaryPlanRef || runState.primaryPlanRef || (task.plans_files || [])[0] || 'unknown';
  const reviewerFeedbackSection = runState.latestReviewerFeedback && phase === 'planning'
    ? `\n## Reviewer Feedback To Address\n${trimForPrompt(runState.latestReviewerFeedback, 12000)}\n`
    : '';

  return `You are the assigned ${runState.agentId} coding agent for backlog task "${task.title}".\n\n## Current Phase\n${PHASE_LABELS[phase]}\n\n## Iteration\n${runState.iteration || 1}\n\n${protocolBlock}\n\n## Phase Instructions\n${phaseInstructions[phase]}${phase === 'validate' ? '\n- Explain what changed in response to the most recent reviewer feedback before reporting MOIRAI_VALIDATE_STATUS.' : ''}\n\n## Human Input History\n${buildHumanInputHistory(runState)}\n${reviewerFeedbackSection}\n## Workspace\nPrimary worktree: ${runState.executionContext?.primaryWorktreePath || 'unknown'}\nBranch: ${runState.executionContext?.branchName || 'unknown'}\n\n## Repositories\n${repoSummary}\n\n## Primary Linked Plan File\n${primaryPlanRef}\n\n## Backlog Task Markdown\nPath: ${context.taskPath}\n\n${trimForPrompt(context.taskMarkdown, 24000)}\n\n## Linked Plan Files\n${planSummary}\n\n## Backlog AGENTS.md\n${trimForPrompt(context.backlogInstructions, 16000)}\n\n## Repo AGENTS.md\n${repoInstructions}\n`;
}

function buildDraftPlanPrompt(runState, task, planRef, additionalInput = '', draftPlanMode = 'deep_draft') {
  const context = buildPromptContext(runState, task);
  const repoSummary = (runState.executionContext?.repos || [])
    .map((repoContext) => `- ${repoContext.repoName}: ${repoContext.worktreePath}`)
    .join('\n');
  const currentPlan = context.plans.find((plan) => plan.ref === planRef)?.content || '';
  const currentPlanParts = splitPlanFeedbackHistory(currentPlan);
  const feedbackHistory = parsePlanFeedbackHistory(currentPlan)
    .filter((entry) => entry.feedback && entry.kind !== 'human_approval')
    .map((entry) => `- Iteration ${entry.iteration || '?'} (${entry.status || 'feedback'}): ${entry.feedback}`)
    .join('\n');

  if (normalizeDraftPlanMode(draftPlanMode) === 'fast_refine') {
    return `You are quickly refining an existing Moirai implementation plan.\n\n## Mission\nUpdate the plan using the latest user feedback. Do not do broad repository rediscovery unless the feedback explicitly requires it. Preserve sections that do not need to change and focus on making the requested plan edits clear, complete, and implementation-ready.\n\n## Output Protocol\n- Print only brief progress updates with MOIRAI_UI_NOTE or MOIRAI_UI_ACTION.\n- Emit the complete replacement plan markdown inside:\n  MOIRAI_PLAN_FILE_BEGIN\n  <full markdown plan content>\n  MOIRAI_PLAN_FILE_END\n- End with the exact line: MOIRAI_PLAN_STATUS: ready\n- Do not edit files directly. Moirai will write your emitted plan into the backlog repo.\n- Do not ask interactive questions.\n\n## Plan File To Produce\n${planRef}\n\n## Latest User Feedback\n${additionalInput.trim() || 'None.'}\n\n## Previous Requested Changes\n${feedbackHistory || 'None.'}\n\n## Repositories\n${repoSummary || 'No implementation repositories listed.'}\n\n## Compact Rules\n- Keep task files lean; implementation detail belongs in plan files.\n- Include security/safety, automated tests, documentation impact, and manual validation when relevant.\n- Respect repository architecture boundaries and approved validation workflows.\n- Avoid secrets and private operational data.\n\n## Backlog Task Markdown\nPath: ${context.taskPath}\n\n${trimForPrompt(context.taskMarkdown, 12000)}\n\n## Current Plan Markdown\n${trimForPrompt(currentPlanParts.body || currentPlan || 'No linked plan content yet.', 18000)}\n`;
  }

  const repoInstructions = context.repoInstructions
    .map((repo) => {
      if (!repo.instructions) {
        return `## ${repo.repoName}\nNo repo-local AGENTS.md found.`;
      }
      return `## ${repo.repoName}\nPath: ${repo.instructions.path}\n\n${trimForPrompt(repo.instructions.content, 12000)}`;
    })
    .join('\n\n');

  return `You are drafting a detailed implementation plan for a Moirai-managed backlog task.\n\n## Mission\nCreate the final plan markdown for the user-provided task. This is a standalone plan-drafting step, not the implementation pipeline. Explore the referenced repository deeply enough to ground the plan in real files, commands, risks, and validation paths.\n\n## Output Protocol\n- Print short progress updates with MOIRAI_UI_NOTE or MOIRAI_UI_ACTION.\n- Emit the complete final plan markdown inside:\n  MOIRAI_PLAN_FILE_BEGIN\n  <full markdown plan content>\n  MOIRAI_PLAN_FILE_END\n- End with the exact line: MOIRAI_PLAN_STATUS: ready\n- Do not edit files directly. Moirai will write your emitted plan into the backlog repo.\n- Do not ask interactive questions. Use the task markdown and the additional user input below.\n\n## Plan File To Produce\n${planRef}\n\n## Additional User Input\n${additionalInput.trim() || 'None.'}\n\n## Repositories To Inspect\n${repoSummary || 'No implementation repositories listed.'}\n\n## Backlog Task Markdown\nPath: ${context.taskPath}\n\n${trimForPrompt(context.taskMarkdown, 24000)}\n\n## Current Linked Plan Content\n${context.plans.map((plan) => `## ${plan.ref}\n\n${trimForPrompt(plan.content, 16000)}`).join('\n\n') || 'No linked plan content yet.'}\n\n## Backlog AGENTS.md\n${trimForPrompt(context.backlogInstructions, 16000)}\n\n## Repo AGENTS.md\n${repoInstructions || 'No repo-local AGENTS.md content found.'}\n`;
}

function buildSecondOpinionPrompt(task, planRef, initialPlan, additionalInput = '') {
  return `You are providing a second opinion on a draft implementation plan.\n\n## Mission\nReview the initial plan and return concrete recommendations only. Do not rewrite the full plan. Focus on risks, missing tests, unclear assumptions, missing implementation details, sequencing problems, and worthwhile improvements.\n\n## Output Protocol\n- Emit recommendations inside:\n  MOIRAI_SECOND_OPINION_BEGIN\n  <markdown recommendations>\n  MOIRAI_SECOND_OPINION_END\n- End with the exact line: MOIRAI_SECOND_OPINION_STATUS: ready\n- Do not edit files directly.\n\n## Task\nTitle: ${task.title || 'Untitled task'}\nGoal: ${task.main_goal || 'N/A'}\nDescription: ${task.short_description || 'N/A'}\n\n## Plan File\n${planRef}\n\n## User Request\n${additionalInput.trim() || 'None.'}\n\n## Initial Plan Draft\n${trimForPrompt(initialPlan, 24000)}\n`;
}

function buildFinalPlanSynthesisPrompt(task, planRef, additionalInput, initialPlan, secondOpinion) {
  return `You are the primary Moirai plan-writing agent.\n\n## Mission\nRead the initial plan and the second-opinion recommendations. Critically decide which recommendations to incorporate and which to discard. Produce the final full implementation plan markdown.\n\n## Output Protocol\n- Emit the complete final plan markdown inside:\n  MOIRAI_PLAN_FILE_BEGIN\n  <full markdown plan content>\n  MOIRAI_PLAN_FILE_END\n- End with the exact line: MOIRAI_PLAN_STATUS: ready\n- Do not edit files directly. Moirai will write your emitted plan into the backlog repo.\n\n## Task\nTitle: ${task.title || 'Untitled task'}\nGoal: ${task.main_goal || 'N/A'}\nDescription: ${task.short_description || 'N/A'}\n\n## Plan File\n${planRef}\n\n## Original User Request\n${additionalInput.trim() || 'None.'}\n\n## Initial Plan Draft\n${trimForPrompt(initialPlan, 24000)}\n\n## Second-Opinion Recommendations\n${trimForPrompt(secondOpinion, 16000)}\n`;
}

function handleParsedTranscriptEvent(runState, parsedEvent) {
  if (parsedEvent.type === 'input_request') {
    const request = {
      ...parsedEvent.request,
      requestedAt: new Date().toISOString(),
      phase: runState.phase,
      phaseLabel: PHASE_LABELS[runState.phase] || runState.phase,
    };
    runState.pendingInputRequest = request;
    appendEvent(runState, 'input_request', { request });
    return;
  }

  if (parsedEvent.type === 'parser_error') {
    appendEvent(runState, 'error', {
      message: parsedEvent.message,
      raw: parsedEvent.raw,
    });
    return;
  }

  appendEvent(runState, parsedEvent.type, parsedEvent);
}

async function runChildProcess(runState, commandSpec, options = {}) {
  const { cwd, prompt, artifactName } = options;
  const commandString = [commandSpec.command, ...commandSpec.args].join(' ');
  logCommand(runState, commandString, artifactName);

  return new Promise((resolve, reject) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd,
      env: {
        ...process.env,
        ...(commandSpec.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const isClaudeStream = commandSpec.parser === 'claude_stream_json';
    let sawChildOutput = false;
    let sawParsedEvent = false;
    let livenessTimer = null;
    let parsingTimer = null;

    const clearClaudeTimers = () => {
      if (livenessTimer) {
        clearTimeout(livenessTimer);
        livenessTimer = null;
      }
      if (parsingTimer) {
        clearTimeout(parsingTimer);
        parsingTimer = null;
      }
    };

    const transcriptHandler = (event) => {
      sawParsedEvent = true;
      clearClaudeTimers();
      handleParsedTranscriptEvent(runState, event);
    };
    const stdoutParser = commandSpec.parser === 'claude_stream_json'
      ? createClaudeStreamJsonParser(transcriptHandler)
      : createTranscriptParser(transcriptHandler);
    const stderrParser = commandSpec.parser === 'claude_stream_json'
      ? stdoutParser
      : createTranscriptParser(transcriptHandler);

    if (isClaudeStream) {
      livenessTimer = setTimeout(() => {
        if (!sawChildOutput && !sawParsedEvent && runState.currentChild === child && !runState.stopRequested) {
          appendEvent(runState, 'system', {
            message: 'Claude session started, waiting for first output.',
          });
        }
      }, 4000);

      parsingTimer = setTimeout(() => {
        if (sawChildOutput && !sawParsedEvent && runState.currentChild === child && !runState.stopRequested) {
          appendEvent(runState, 'system', {
            message: 'Claude produced output, but it has not been parsed into Activity yet.',
          });
        }
      }, 9000);
    }

    runState.currentChild = child;
    runState.currentCommand = commandString;
    persistRunState(runState);

    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      sawChildOutput = true;
      output += text;
      appendRawLog(runState, text, artifactName);
      if (commandSpec.stdoutArtifactName) {
        appendRawLog(runState, text, commandSpec.stdoutArtifactName);
      }
      stdoutParser.processChunk(text, 'stdout');
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      sawChildOutput = true;
      output += text;
      appendRawLog(runState, text, artifactName);
      if (commandSpec.stderrArtifactName) {
        appendRawLog(runState, text, commandSpec.stderrArtifactName);
      }
      stderrParser.processChunk(text, 'stderr');
    });

    child.on('error', (error) => {
      clearClaudeTimers();
      runState.currentChild = null;
      runState.currentCommand = null;
      reject(error);
    });

    child.on('close', (code) => {
      clearClaudeTimers();
      stdoutParser.flush('stdout');
      stderrParser.flush('stderr');
      runState.currentChild = null;
      runState.currentCommand = null;
      resolve({ code, output });
    });

    if (commandSpec.stdinPrompt) {
      child.stdin.write(prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function runLoggedCommand(runState, command, args, options = {}) {
  const artifactName = options.artifactName || 'phase-0-bootstrap';
  const commandString = [command, ...args].join(' ');
  logCommand(runState, commandString, artifactName);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      appendRawLog(runState, text, artifactName);
      const trimmed = text.trim();
      if (trimmed) {
        appendEvent(runState, 'system_output', { message: trimmed });
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      appendRawLog(runState, text, artifactName);
      const trimmed = text.trim();
      if (trimmed) {
        appendEvent(runState, 'error', { message: trimmed });
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${commandString} failed with exit code ${code}\n${output}`));
        return;
      }
      resolve(output);
    });
  });
}

async function probeCommand(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function resolveBaseRef(repoRoot) {
  const configuredBase = CONFIG.defaultBaseBranch || 'master';
  const candidates = [
    `origin/${configuredBase}`,
    configuredBase,
    'origin/main',
    'main',
    'origin/master',
    'master',
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await probeCommand('git', ['-C', repoRoot, 'rev-parse', '--verify', candidate], repoRoot)) {
      return candidate;
    }
  }
  throw new Error(`unable to resolve base branch for ${repoRoot}`);
}

async function bootstrapExecutionContext(runState, task) {
  const existingRuntime = getTaskRuntime(runState.taskId);
  if ((task.branch_name || []).length > 0 && existingRuntime.executionContext) {
    logSystem(runState, '[planning] Reusing existing execution context.', 'phase-bootstrap');
    runState.executionContext = existingRuntime.executionContext;
    backlog.markTaskInProgress(BACKLOG_ROOT, task.filename);
    persistRunState(runState);
    return;
  }

  const branchName = (task.branch_name || [])[0] || branchSlug(task);
  const repos = [];
  const createdWorktrees = [];

  try {
    for (const repoName of task.repository || []) {
      const repoRoot = resolveRepoPath(repoName);
      const baseRef = await resolveBaseRef(repoRoot);
      const worktreePath = path.join(CONFIG.worktreeRoot, repoName, branchName);

      if (fs.existsSync(worktreePath)) {
        repos.push({
          repoName,
          repoRoot,
          baseRef,
          worktreePath,
        });
        continue;
      }
      if (await probeCommand('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoRoot)) {
        throw new Error(`branch already exists for ${repoName}: ${branchName}`);
      }

      logSystem(runState, `[planning] Creating worktree for ${repoName} from ${baseRef}`, 'phase-bootstrap');
      ensureDir(path.dirname(worktreePath));
      await runLoggedCommand(
        runState,
        'git',
        ['-C', repoRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseRef],
        { artifactName: 'phase-bootstrap' },
      );
      createdWorktrees.push({ repoRoot, worktreePath });
      repos.push({
        repoName,
        repoRoot,
        baseRef,
        worktreePath,
      });
    }

    const startDate = new Date().toISOString().slice(0, 10);
    if ((task.branch_name || []).length === 0) {
      backlog.setTaskStarted(BACKLOG_ROOT, task.filename, branchName, startDate);
    } else {
      backlog.markTaskInProgress(BACKLOG_ROOT, task.filename);
    }
    runState.executionContext = {
      branchName,
      primaryRepo: repos[0]?.repoName || null,
      primaryWorktreePath: repos[0]?.worktreePath || null,
      repos,
    };
    logSystem(runState, `[planning] Task moved into active implementation on ${branchName}.`, 'phase-bootstrap');
    persistRunState(runState);
  } catch (error) {
    for (const worktree of createdWorktrees.reverse()) {
      try {
        await runLoggedCommand(
          runState,
          'git',
          ['-C', worktree.repoRoot, 'worktree', 'remove', '--force', worktree.worktreePath],
          { artifactName: 'phase-bootstrap' },
        );
      } catch {
        try {
          fs.rmSync(worktree.worktreePath, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure
        }
      }
    }
    throw error;
  }
}

function parseMarker(output, prefix) {
  const match = output.match(new RegExp(`${prefix}:\\s*([A-Za-z_-]+)`, 'i'));
  return match ? match[1].toLowerCase() : null;
}

function saveTextArtifact(runState, key, artifactName, content) {
  const normalized = normalizeMarkdown(content);
  const versionedName = `${artifactName}.iteration-${runState.iteration || 1}`;
  fs.writeFileSync(runArtifactPath(runState.id, versionedName), normalized, 'utf-8');
  runState.artifacts[key] = versionedName;
  runState.artifactHistory[key] = runState.artifactHistory[key] || [];
  runState.artifactHistory[key].push(versionedName);
  if (!runState.phaseArtifacts.includes(versionedName)) {
    runState.phaseArtifacts.push(versionedName);
  }
  persistRunState(runState);
  return versionedName;
}

function ensureNamedArtifact(runState, key, artifactName, initialContent = '') {
  const filePath = runArtifactPath(runState.id, artifactName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, initialContent, 'utf-8');
  }
  runState.artifacts[key] = artifactName;
  if (!runState.phaseArtifacts.includes(artifactName)) {
    runState.phaseArtifacts.push(artifactName);
  }
  persistRunState(runState);
  return artifactName;
}

function computePromptStats(runState, task, phase, prompt) {
  const context = buildPromptContext(runState, task);
  const plans = context.plans || [];
  const repoInstructions = context.repoInstructions || [];

  return {
    phase,
    promptBytes: Buffer.byteLength(prompt || '', 'utf-8'),
    taskMarkdownBytes: Buffer.byteLength(context.taskMarkdown || '', 'utf-8'),
    linkedPlanBytes: plans.reduce((sum, plan) => sum + Buffer.byteLength(plan.content || '', 'utf-8'), 0),
    linkedPlanCount: plans.length,
    backlogInstructionsBytes: Buffer.byteLength(context.backlogInstructions || '', 'utf-8'),
    repoInstructionsBytes: repoInstructions.reduce((sum, repo) => sum + Buffer.byteLength(repo.instructions?.content || '', 'utf-8'), 0),
    repoInstructionsCount: repoInstructions.filter((repo) => repo.instructions?.content).length,
    humanInputHistoryBytes: Buffer.byteLength(buildHumanInputHistory(runState), 'utf-8'),
  };
}

function getCurrentTaskForRun(filename) {
  return backlog.readTask(BACKLOG_ROOT, 'doing', filename)
    || backlog.readTask(BACKLOG_ROOT, 'review', filename);
}

function updateLinkedPlanFromPlanningPhase(runState, task, output) {
  const agentPlan = extractDelimitedBlock(output, 'MOIRAI_AGENT_PLAN_BEGIN', 'MOIRAI_AGENT_PLAN_END');
  if (!agentPlan) {
    throw new Error('Agent Plan phase did not emit MOIRAI_AGENT_PLAN content');
  }

  const agentPlanStatus = parseMarker(output, 'MOIRAI_AGENT_PLAN_STATUS');
  if (agentPlanStatus !== 'ready') {
    throw new Error('Agent Plan phase did not finish with MOIRAI_AGENT_PLAN_STATUS: ready');
  }

  const primaryPlanRef = getPrimaryPlanRef(task);
  const currentPlan = readPlanFile(BACKLOG_ROOT, primaryPlanRef);
  const updatedPlan = upsertAgentPlanAppendix(currentPlan, agentPlan, {
    generatedAt: new Date().toISOString(),
    runId: runState.id,
  });
  writePlanFile(BACKLOG_ROOT, primaryPlanRef, updatedPlan);
  runState.primaryPlanRef = primaryPlanRef;
  saveTextArtifact(runState, 'agentPlan', 'agent-plan', agentPlan);
  appendEvent(runState, 'plan_file_updated', {
    planRef: primaryPlanRef,
    message: `Updated Agent Plan appendix in linked plan file: ${primaryPlanRef}`,
  });

  return primaryPlanRef;
}

function finalizeValidateArtifacts(runState, task, output) {
  const validateStatus = parseMarker(output, 'MOIRAI_VALIDATE_STATUS');
  if (!validateStatus) {
    throw new Error('validate phase did not emit MOIRAI_VALIDATE_STATUS');
  }
  if (validateStatus !== 'pass') {
    throw new Error(`validate phase reported ${validateStatus}`);
  }

  const validateSummary = extractDelimitedBlock(output, 'MOIRAI_VALIDATE_SUMMARY_BEGIN', 'MOIRAI_VALIDATE_SUMMARY_END');
  if (!validateSummary) {
    throw new Error('validate phase did not emit MOIRAI_VALIDATE_SUMMARY content');
  }

  const manualTestInstructions = extractDelimitedBlock(output, 'MOIRAI_MANUAL_TEST_BEGIN', 'MOIRAI_MANUAL_TEST_END');
  if (!manualTestInstructions) {
    throw new Error('validate phase did not emit MOIRAI_MANUAL_TEST content');
  }

  const docsStatus = parseMarker(output, 'MOIRAI_DOCS_STATUS') || 'updated';
  const primaryPlanRef = runState.primaryPlanRef || getPrimaryPlanRef(task);
  const completedAt = new Date().toISOString();

  saveTextArtifact(runState, 'validateSummary', 'validate-summary', validateSummary);
  saveTextArtifact(runState, 'manualTestInstructions', 'manual-test-instructions', manualTestInstructions);
  markPlanExecuted(BACKLOG_ROOT, primaryPlanRef, {
    completedAt,
    validateSummary,
    manualTestInstructions,
  });

  runState.validationStatus = validateStatus;
  runState.docsStatus = docsStatus;
  runState.primaryPlanRef = primaryPlanRef;

  appendEvent(runState, 'tests_finished', {
    message: 'Backend automated tests completed in Validate phase.',
    status: 'completed',
  });
  appendEvent(runState, 'docs_updated', {
    message: `Documentation status: ${docsStatus}`,
    status: docsStatus,
  });
  appendEvent(runState, 'manual_test_instructions_ready', {
    message: 'Manual test instructions are ready for review.',
    artifact: 'manual-test-instructions',
  });
  appendEvent(runState, 'plan_file_updated', {
    planRef: primaryPlanRef,
    message: `Marked linked plan as executed: ${primaryPlanRef}`,
  });

  return {
    validateStatus,
    docsStatus,
    validateSummary,
    manualTestInstructions,
  };
}

function savePromptArtifact(runState, phase, prompt) {
  const fileName = `${phase}-prompt.md`;
  fs.writeFileSync(path.join(runDirectory(runState.id), fileName), prompt, 'utf-8');
  if (!runState.promptArtifacts.includes(fileName)) {
    runState.promptArtifacts.push(fileName);
  }
}

async function runAgentPhase(runState, task, phase, extra = {}) {
  if (runState.stopRequested) {
    throw new Error('run stopped');
  }

  const taskRuntime = getTaskRuntime(runState.taskId);
  const selectionCheck = validatePhaseSelection(phase, getPhaseSelection(taskRuntime.phaseConfig, phase), {
    requireAgent: true,
  });
  if (selectionCheck.error) {
    throw new Error(selectionCheck.error);
  }

  runState.agentId = selectionCheck.selection.agentId;

  setRunState(runState, {
    status: 'running',
    phase,
    phaseSelection: selectionCheck.selection,
    waitingForInput: false,
    pendingInputRequest: null,
  });
  runState.pendingResumeContext = null;
  runState.currentPhaseContext = {
    currentPhase: phase,
  };
  logPhase(runState, phase);

  const prompt = buildPhasePrompt(runState, task, phase, extra);
  savePromptArtifact(runState, phase, prompt);

  const primaryWorktree = runState.executionContext?.primaryWorktreePath;
  if (!primaryWorktree) {
    throw new Error('missing execution context');
  }

  const extraDirs = (runState.executionContext?.repos || [])
    .map((repo) => repo.worktreePath)
    .filter((worktreePath) => worktreePath !== primaryWorktree);

  const commandSpec = buildAgentCommand(runState.agentId, CONFIG, {
    phase,
    cwd: primaryWorktree,
    prompt,
    addDirs: [BACKLOG_ROOT, ...extraDirs],
    runtimeDir: runDirectory(runState.id),
    model: selectionCheck.selection.model || null,
    effort: selectionCheck.selection.effort || null,
  });

  if (runState.agentId === 'claude') {
    if (commandSpec.debugArtifactName) {
      ensureNamedArtifact(runState, 'claudeDebug', commandSpec.debugArtifactName);
    }
    if (commandSpec.stdoutArtifactName) {
      ensureNamedArtifact(runState, 'claudeStdoutRaw', commandSpec.stdoutArtifactName);
    }
    if (commandSpec.stderrArtifactName) {
      ensureNamedArtifact(runState, 'claudeStderrRaw', commandSpec.stderrArtifactName);
    }

    const promptStats = computePromptStats(runState, task, phase, prompt);
    ensureNamedArtifact(runState, 'promptStats', 'prompt-stats', `${JSON.stringify(promptStats, null, 2)}\n`);
    appendEvent(runState, 'system', {
      message: `Claude prompt size: ${promptStats.promptBytes} bytes (task ${promptStats.taskMarkdownBytes}, plans ${promptStats.linkedPlanBytes}, backlog AGENTS ${promptStats.backlogInstructionsBytes}, repo AGENTS ${promptStats.repoInstructionsBytes}).`,
    });
    if (promptStats.promptBytes > 20000) {
      appendEvent(runState, 'system', {
        message: `Claude prompt is large (${promptStats.promptBytes} bytes). If Claude remains silent, inspect Prompt Stats and Claude debug artifacts.`,
      });
    }
  }

  const artifactName = `${phase}-${runState.reviewAttempts}`;
  const result = await runChildProcess(runState, { ...commandSpec, prompt }, {
    cwd: primaryWorktree,
    prompt,
    artifactName,
  });

  if (runState.stopRequested) {
    throw new Error('run stopped');
  }

  if (runState.pendingInputRequest) {
    runState.pendingResumeContext = {
      currentPhase: phase,
    };
    setRunState(runState, {
      status: 'awaiting_input',
      waitingForInput: true,
      pendingInputRequest: runState.pendingInputRequest,
    });
    appendEvent(runState, 'system', {
      message: `Run paused for human input during ${PHASE_LABELS[phase]}.`,
    });
    return {
      paused: true,
      output: result.output,
    };
  }

  if (result.code !== 0) {
    throw new Error(`${PHASE_LABELS[phase]} failed with exit code ${result.code}`);
  }

  return {
    paused: false,
    output: result.output,
  };
}

async function executePlanningPhase(runState, task) {
  const planning = await runAgentPhase(runState, task, 'planning', {
    primaryPlanRef: runState.primaryPlanRef || getPrimaryPlanRef(task),
  });
  if (planning.paused) {
    return { paused: true, task };
  }

  updateLinkedPlanFromPlanningPhase(runState, task, planning.output);
  appendEvent(runState, 'system', {
    message: 'Agent Plan phase completed and linked backlog plan appendix was updated.',
  });

  const updatedTask = getCurrentTaskForRun(runState.filename);
  if (!updatedTask) {
    throw new Error('task disappeared after planning');
  }

  return { paused: false, task: updatedTask };
}

async function executeImplementingPhase(runState, task) {
  const implementing = await runAgentPhase(runState, task, 'implementing', {
    primaryPlanRef: runState.primaryPlanRef || getPrimaryPlanRef(task),
  });
  if (implementing.paused) {
    return { paused: true, task };
  }

  const implementationStatus = parseMarker(implementing.output, 'MOIRAI_IMPLEMENTATION_STATUS');
  if (!implementationStatus) {
    throw new Error('implementing phase did not emit MOIRAI_IMPLEMENTATION_STATUS');
  }
  if (implementationStatus === 'blocked') {
    throw new Error('implementing phase reported a blocker');
  }
  if (implementationStatus !== 'complete') {
    throw new Error(`implementing phase reported ${implementationStatus}`);
  }

  appendEvent(runState, 'system', {
    message: 'Implementing phase completed successfully.',
  });

  const updatedTask = getCurrentTaskForRun(runState.filename);
  if (!updatedTask) {
    throw new Error('task disappeared after implementation');
  }

  return { paused: false, task: updatedTask };
}

async function executeValidatePhase(runState, task) {
  appendEvent(runState, 'tests_started', {
    message: 'Validate phase started. Backend automated tests are required in this phase.',
    status: 'started',
  });

  const validate = await runAgentPhase(runState, task, 'validate', {
    primaryPlanRef: runState.primaryPlanRef || getPrimaryPlanRef(task),
  });
  if (validate.paused) {
    return { paused: true, task };
  }

  finalizeValidateArtifacts(runState, task, validate.output);
  appendEvent(runState, 'system', {
    message: 'Validate phase completed successfully.',
  });

  backlog.markTaskReadyForReview(BACKLOG_ROOT, runState.filename);
  appendEvent(runState, 'success', {
    message: 'Task marked ready for review and moved into the Review column.',
  });
  runState.finishedAt = new Date().toISOString();
  setRunState(runState, {
    status: 'completed',
    reviewState: 'pending_review',
    waitingForInput: false,
    pendingInputRequest: null,
  });

  return { paused: false, task: getCurrentTaskForRun(runState.filename) };
}

async function continueWorkflow(runState, task, context) {
  let currentTask = task;
  let currentPhase = context.currentPhase;

  if (currentPhase === 'planning') {
    const planning = await executePlanningPhase(runState, currentTask);
    if (planning.paused) {
      return false;
    }
    currentTask = planning.task;
    currentPhase = 'implementing';
  }

  if (currentPhase === 'implementing') {
    const implementing = await executeImplementingPhase(runState, currentTask);
    if (implementing.paused) {
      return false;
    }
    currentTask = implementing.task;
    currentPhase = 'validate';
  }

  if (currentPhase === 'validate') {
    const validate = await executeValidatePhase(runState, currentTask);
    if (validate.paused) {
      return false;
    }
  }

  return true;
}

async function executeRun(runState, options = {}) {
  try {
    if (!options.resume) {
      const taskRuntime = getTaskRuntime(runState.taskId);
      const planningSelection = getPhaseSelection(taskRuntime.phaseConfig, 'planning');
      setRunState(runState, {
        status: 'running',
        phase: 'planning',
        phaseSelection: planningSelection,
        waitingForInput: false,
        pendingInputRequest: null,
      });
      logSystem(runState, `Agent Plan agent: ${planningSelection.agentId || 'unassigned'}`);

      const stagedTask = backlog.readTask(BACKLOG_ROOT, 'doing', runState.filename);
      if (!stagedTask) {
        throw new Error('task is no longer available in doing');
      }

      logSystem(runState, 'Agent Plan phase bootstrap is creating or reusing the feature worktree and branch.', 'phase-bootstrap');
      await bootstrapExecutionContext(runState, stagedTask);

      const activeTask = getCurrentTaskForRun(runState.filename);
      if (!activeTask) {
        throw new Error('task disappeared after bootstrap');
      }

      await continueWorkflow(runState, activeTask, {
        currentPhase: 'planning',
      });
    } else {
      const activeTask = getCurrentTaskForRun(runState.filename);
      if (!activeTask) {
        throw new Error('task is no longer available while resuming');
      }

      await continueWorkflow(runState, activeTask, options.context);
    }
  } catch (error) {
    if (runState.stopRequested) {
      runState.finishedAt = new Date().toISOString();
      setRunState(runState, {
        status: 'stopped',
        waitingForInput: false,
        pendingInputRequest: null,
        errorMessage: null,
      });
      logSystem(runState, '[run] Execution stopped by user request.', null, 'system');
    } else {
      logSystem(runState, `[run] ${error.message}`, null, 'error');
      const currentTask = getCurrentTaskForRun(runState.filename);
      if (currentTask && (currentTask.branch_name || []).length > 0) {
        try {
          backlog.markTaskBlocked(BACKLOG_ROOT, runState.filename);
        } catch {
          // ignore task-state update failures after the main error
        }
      }
      runState.finishedAt = new Date().toISOString();
      setRunState(runState, {
        status: 'failed',
        waitingForInput: false,
        pendingInputRequest: null,
        errorMessage: error.message,
      });
    }
  } finally {
    persistRunState(runState);
    if (runState.status === 'awaiting_input') {
      return;
    }

    ACTIVE_RUNS.delete(runState.id);
    persistRunState(runState);
    for (const client of runState.clients) {
      try {
        client.close();
      } catch {
        // ignore socket shutdown errors
      }
    }
    runState.clients.clear();
  }
}

function createRun(task, agentId) {
  const runId = randomUUID();
  const taskId = backlog.taskFilenameToId(task.filename);
  const runtime = getTaskRuntime(taskId);
  const planningSelection = getPhaseSelection(runtime.phaseConfig, 'planning');
  const runState = {
    id: runId,
    taskId,
    filename: task.filename,
    agentId: agentId || planningSelection.agentId || null,
    status: 'queued',
    phase: 'planning',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
    waitingForInput: false,
    pendingInputRequest: null,
    pendingResumeContext: null,
    currentPhaseContext: null,
    reviewAttempts: 0,
    iteration: 1,
    reviewState: null,
    latestReviewerFeedback: null,
    reviewFeedbackHistory: [],
    validationStatus: null,
    docsStatus: null,
    phaseSelection: planningSelection,
    primaryPlanRef: null,
    executionContext: runtime.executionContext,
    promptArtifacts: [],
    phaseArtifacts: [],
    artifacts: {},
    artifactHistory: {},
    inputHistory: [],
    clients: new Set(),
    currentChild: null,
    currentCommand: null,
    stopRequested: false,
    eventSequence: 0,
  };

  ensureDir(runDirectory(runId));
  fs.writeFileSync(runTerminalPath(runId), '', 'utf-8');
  fs.writeFileSync(runEventsPath(runId), '', 'utf-8');
  ACTIVE_RUNS.set(runId, runState);
  persistRunState(runState);
  return runState;
}

async function buildDraftPlanExecutionContext(task) {
  const repos = [];
  for (const repoName of task.repository || []) {
    const repoRoot = resolveRepoPath(repoName);
    const baseRef = await resolveBaseRef(repoRoot);
    repos.push({
      repoName,
      repoRoot,
      baseRef,
      worktreePath: repoRoot,
    });
  }

  return {
    branchName: null,
    primaryRepo: repos[0]?.repoName || null,
    primaryWorktreePath: repos[0]?.worktreePath || BACKLOG_ROOT,
    repos,
  };
}

async function createDraftPlanRun(task, selection, planRef, additionalInput, draftPlanMode, secondOpinionEnabled = false, secondOpinionConfig = null) {
  const runId = randomUUID();
  const taskId = backlog.taskFilenameToId(task.filename);
  const runtime = getTaskRuntime(taskId);
  const executionContext = await buildDraftPlanExecutionContext(task);
  const iteration = (runtime.planGenerationIteration || 0) + 1;
  const runState = {
    id: runId,
    runKind: 'draft_plan',
    taskId,
    filename: task.filename,
    agentId: selection.agentId,
    status: 'queued',
    phase: 'draft_plan',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
    waitingForInput: false,
    pendingInputRequest: null,
    pendingResumeContext: null,
    currentPhaseContext: null,
    reviewAttempts: 0,
    iteration,
    reviewState: null,
    latestReviewerFeedback: null,
    reviewFeedbackHistory: [],
    validationStatus: null,
    docsStatus: null,
    phaseSelection: selection,
    primaryPlanRef: planRef,
    draftPlanMode: normalizeDraftPlanMode(draftPlanMode),
    secondOpinionEnabled: Boolean(secondOpinionEnabled),
    secondOpinionConfig,
    executionContext,
    promptArtifacts: [],
    phaseArtifacts: [],
    artifacts: {},
    artifactHistory: {},
    inputHistory: [],
    additionalInput,
    clients: new Set(),
    currentChild: null,
    currentCommand: null,
    stopRequested: false,
    eventSequence: 0,
  };

  ensureDir(runDirectory(runId));
  fs.writeFileSync(runTerminalPath(runId), '', 'utf-8');
  fs.writeFileSync(runEventsPath(runId), '', 'utf-8');
  ACTIVE_RUNS.set(runId, runState);
  persistRunState(runState);
  return runState;
}

function tempPlanRef(planRef, runId, kind) {
  const dir = path.dirname(planRef);
  const base = path.basename(planRef, '.md');
  return path.join(dir, `.${base}.${kind}.${runId}.md`).replace(/\\/g, '/');
}

function writeTempPlanFile(planRef, content) {
  const resolved = path.resolve(BACKLOG_ROOT, planRef);
  if (!resolved.startsWith(BACKLOG_ROOT + path.sep)) {
    throw new Error('forbidden temp plan path');
  }
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, normalizeMarkdown(content), 'utf-8');
  return resolved;
}

function deleteTempPlanFile(planRef) {
  try {
    const resolved = path.resolve(BACKLOG_ROOT, planRef);
    if (!resolved.startsWith(BACKLOG_ROOT + path.sep)) {
      return;
    }
    fs.unlinkSync(resolved);
  } catch {
    // Keep cleanup best-effort; temp files are debug artifacts on failure.
  }
}

async function runDraftAgentStep(runState, selection, prompt, artifactName) {
  const previousSelection = runState.phaseSelection;
  runState.phaseSelection = selection;
  persistRunState(runState);

  savePromptArtifact(runState, artifactName, prompt);
  const primaryCwd = runState.executionContext?.primaryWorktreePath || BACKLOG_ROOT;
  const extraDirs = [
    BACKLOG_ROOT,
    ...(runState.executionContext?.repos || []).map((repo) => repo.worktreePath),
  ];
  const commandSpec = buildAgentCommand(selection.agentId, CONFIG, {
    phase: 'draft_plan',
    cwd: primaryCwd,
    prompt,
    addDirs: extraDirs,
    runtimeDir: runDirectory(runState.id),
    model: selection.model || null,
    effort: selection.effort || null,
  });
  let result;
  try {
    result = await runChildProcess(runState, { ...commandSpec, prompt }, {
      cwd: primaryCwd,
      prompt,
      artifactName,
    });
  } finally {
    runState.phaseSelection = previousSelection;
    persistRunState(runState);
  }

  if (result.code !== 0) {
    throw new Error(`${artifactName} agent exited with code ${result.code}`);
  }
  return result;
}

function extractReadyPlan(output, label) {
  const generatedPlan = extractDelimitedBlock(output, 'MOIRAI_PLAN_FILE_BEGIN', 'MOIRAI_PLAN_FILE_END');
  if (!generatedPlan) {
    throw new Error(`${label} did not emit MOIRAI_PLAN_FILE content`);
  }
  const planStatus = parseMarker(output, 'MOIRAI_PLAN_STATUS');
  if (planStatus !== 'ready') {
    throw new Error(`${label} did not finish with MOIRAI_PLAN_STATUS: ready`);
  }
  return generatedPlan;
}

function extractSecondOpinion(output) {
  const recommendations = extractDelimitedBlock(output, 'MOIRAI_SECOND_OPINION_BEGIN', 'MOIRAI_SECOND_OPINION_END');
  if (!recommendations) {
    throw new Error('second-opinion agent did not emit MOIRAI_SECOND_OPINION content');
  }
  const opinionStatus = parseMarker(output, 'MOIRAI_SECOND_OPINION_STATUS');
  if (opinionStatus !== 'ready') {
    throw new Error('second-opinion agent did not finish with MOIRAI_SECOND_OPINION_STATUS: ready');
  }
  return recommendations;
}

async function executeDraftPlanRun(runState, task, planRef, additionalInput) {
  const tempRefs = [];
  let keepTempFiles = false;
  try {
    setRunState(runState, {
      status: 'running',
      phase: 'draft_plan',
      phaseSelection: runState.phaseSelection,
      waitingForInput: false,
      pendingInputRequest: null,
    });
    logPhase(runState, 'draft_plan');

    const primarySelection = runState.phaseSelection;
    const initialPrompt = buildDraftPlanPrompt(runState, task, planRef, additionalInput, runState.draftPlanMode);
    const initialResult = await runDraftAgentStep(runState, primarySelection, initialPrompt, runState.secondOpinionEnabled ? 'draft-plan-initial' : 'draft-plan');
    let generatedPlan = extractReadyPlan(initialResult.output, 'draft plan agent');

    if (runState.secondOpinionEnabled) {
      const initialRef = tempPlanRef(planRef, runState.id, 'initial');
      writeTempPlanFile(initialRef, generatedPlan);
      tempRefs.push(initialRef);
      appendEvent(runState, 'system', { message: 'Initial plan drafted.' });

      const secondPrompt = buildSecondOpinionPrompt(task, planRef, generatedPlan, additionalInput);
      appendEvent(runState, 'system', { message: 'Second opinion requested.' });
      const secondResult = await runDraftAgentStep(runState, runState.secondOpinionConfig, secondPrompt, 'draft-plan-second-opinion');
      const secondOpinion = extractSecondOpinion(secondResult.output);
      const secondOpinionRef = tempPlanRef(planRef, runState.id, 'second-opinion');
      writeTempPlanFile(secondOpinionRef, secondOpinion);
      tempRefs.push(secondOpinionRef);
      appendEvent(runState, 'system', { message: 'Second opinion received.' });

      const finalPrompt = buildFinalPlanSynthesisPrompt(task, planRef, additionalInput, generatedPlan, secondOpinion);
      appendEvent(runState, 'system', { message: 'Final plan synthesis.' });
      const finalResult = await runDraftAgentStep(runState, primarySelection, finalPrompt, 'draft-plan-final');
      generatedPlan = extractReadyPlan(finalResult.output, 'final plan synthesis agent');
    }

    const currentPlan = safeReadText(path.join(BACKLOG_ROOT, planRef));
    const existingHistory = splitPlanFeedbackHistory(currentPlan).history;
    const planWithFeedback = appendPlanFeedbackEntry(`${generatedPlan}\n\n${existingHistory}`, {
      timestamp: new Date().toISOString(),
      iteration: runState.iteration || 1,
      kind: 'agent_generation',
      status: 'generated',
      runId: runState.id,
      feedback: additionalInput,
    });
    writePlanFile(BACKLOG_ROOT, planRef, planWithFeedback);
    saveTextArtifact(runState, 'generatedPlan', 'generated-plan', generatedPlan);
    appendEvent(runState, 'plan_file_updated', {
      planRef,
      message: runState.secondOpinionEnabled
        ? `Drafted linked plan file with second opinion: ${planRef}`
        : `Drafted linked plan file: ${planRef}`,
    });

    const runtime = getTaskRuntime(runState.taskId);
    runtime.planState = 'generated';
    runtime.planApprovedAt = null;
    runtime.planApprovedBy = null;
    runtime.planGenerationIteration = runState.iteration || ((runtime.planGenerationIteration || 0) + 1);
    saveTaskRuntime(runState.taskId, runtime);

    runState.finishedAt = new Date().toISOString();
    setRunState(runState, {
      status: 'completed',
      waitingForInput: false,
      pendingInputRequest: null,
      errorMessage: null,
    });
  } catch (error) {
    keepTempFiles = true;
    logSystem(runState, `[draft-plan] ${error.message}`, null, 'error');
    runState.finishedAt = new Date().toISOString();
    setRunState(runState, {
      status: 'failed',
      waitingForInput: false,
      pendingInputRequest: null,
      errorMessage: error.message,
    });
  } finally {
    if (!keepTempFiles) {
      tempRefs.forEach(deleteTempPlanFile);
    }
    ACTIVE_RUNS.delete(runState.id);
    persistRunState(runState);
    for (const client of runState.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    runState.clients.clear();
  }
}

function readRunMetaOrThrow(runId) {
  const meta = safeReadJson(runMetaPath(runId), null);
  if (!meta) {
    throw new Error('run not found');
  }
  return meta;
}

function readRunEvents(runId) {
  return safeReadJsonLines(runEventsPath(runId));
}

function hydrateRunState(runId, taskId) {
  const meta = readRunMetaOrThrow(runId);
  const events = readRunEvents(runId);
  const runtime = getTaskRuntime(taskId);

  const runState = {
    id: meta.id,
    taskId: meta.taskId || taskId,
    filename: meta.taskId || taskId,
    agentId: meta.agentId,
    status: meta.status,
    phase: meta.phase,
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    finishedAt: meta.finishedAt || null,
    errorMessage: meta.errorMessage || null,
    waitingForInput: Boolean(meta.waitingForInput),
    pendingInputRequest: meta.pendingInputRequest || null,
    pendingResumeContext: null,
    currentPhaseContext: meta.phase ? { currentPhase: meta.phase } : null,
    reviewAttempts: meta.reviewAttempts || 0,
    iteration: meta.iteration || 1,
    reviewState: meta.reviewState || null,
    latestReviewerFeedback: meta.latestReviewerFeedback || null,
    reviewFeedbackHistory: meta.reviewFeedbackHistory || [],
    validationStatus: meta.validationStatus || null,
    docsStatus: meta.docsStatus || null,
    phaseSelection: meta.phaseSelection || getPhaseSelection(runtime.phaseConfig, meta.phase || 'planning'),
    primaryPlanRef: meta.primaryPlanRef || null,
    draftPlanMode: meta.draftPlanMode || null,
    secondOpinionEnabled: Boolean(meta.secondOpinionEnabled),
    secondOpinionConfig: meta.secondOpinionConfig || null,
    executionContext: meta.executionContext || null,
    promptArtifacts: meta.promptArtifacts || [],
    phaseArtifacts: meta.phaseArtifacts || [],
    artifacts: meta.artifacts || {},
    artifactHistory: meta.artifactHistory || {},
    inputHistory: meta.inputHistory || [],
    additionalInput: meta.additionalInput || null,
    clients: new Set(),
    currentChild: null,
    currentCommand: null,
    stopRequested: false,
    eventSequence: events.length,
  };

  ACTIVE_RUNS.set(runId, runState);
  persistRunState(runState);
  return runState;
}

function reloadConfigAfterSetup() {
  const nextConfig = loadBoardConfig(PROJECT_ROOT);
  for (const key of Object.keys(CONFIG)) {
    delete CONFIG[key];
  }
  Object.assign(CONFIG, nextConfig);
  BACKLOG_ROOT = CONFIG.repos.backlog || CONFIG.boardRoot || PROJECT_ROOT;
  saveDiscoveredAgentCatalog(PROJECT_ROOT, DISCOVERED_AGENT_CONFIG);
  CONFIG.agents = {
    ...CONFIG.agents,
    ...DISCOVERED_AGENT_CONFIG,
  };
  ensureRuntimeDirs();
  cleanupStaleRuns();
}

app.get('/api/setup/status', (_req, res) => {
  const detection = detectProject(PROJECT_ROOT);
  res.json({
    setupMode,
    detection,
    suggestedRepositories: suggestRepositories(PROJECT_ROOT),
    agents: AGENTS,
  });
});

app.post('/api/setup/init', (req, res) => {
  try {
    const repositories = req.body?.repositories && typeof req.body.repositories === 'object'
      ? req.body.repositories
      : suggestRepositories(PROJECT_ROOT);
    const result = initializeProject(PROJECT_ROOT, {
      repositories,
      overwriteConfig: Boolean(req.body?.overwriteConfig),
      host: HOST,
      port: PORT,
    });
    setupMode = false;
    reloadConfigAfterSetup();
    res.json({
      ok: true,
      result,
      detection: detectProject(PROJECT_ROOT),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/doctor', (_req, res) => {
  res.json(doctorProject(PROJECT_ROOT));
});

app.get('/api/agents', (_req, res) => {
  res.json({ agents: AGENTS });
});

app.get('/api/tasks', (_req, res) => {
  res.json(loadBoardResponse());
});

app.get('/api/tasks/archived', (_req, res) => {
  res.json(backlog.loadArchivedTasks(BACKLOG_ROOT).map(enrichTask));
});

app.get('/api/tasks/:column/:filename/run', (req, res) => {
  const task = readTaskForBoardColumn(req.params.column, req.params.filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(task.runtime);
});

app.post('/api/tasks/:column/:filename/labels', (req, res) => {
  const { column, filename } = req.params;
  const { labels } = req.body;
  const storageColumn = backlog.getStorageColumnForBoardColumn(column);

  try {
    const task = backlog.updateTaskLabels(BACKLOG_ROOT, storageColumn, filename, labels);
    res.json(enrichTask(task));
  } catch (error) {
    if (error.message === 'invalid label value') {
      return res.status(400).json({ error: error.message });
    }
    if (error.message === 'not found') {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:fromColumn/:filename/move', (req, res) => {
  const { fromColumn, filename } = req.params;
  const { toColumn } = req.body;

  if (!backlog.isValidBoardColumn(fromColumn) || !backlog.isValidBoardColumn(toColumn) || fromColumn === toColumn) {
    return res.status(400).json({ error: 'invalid columns' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  if (runtime.activeRunId && ACTIVE_RUNS.has(runtime.activeRunId)) {
    return res.status(409).json({ error: 'task has an active run' });
  }

  try {
    const task = backlog.moveTask(BACKLOG_ROOT, fromColumn, filename, toColumn);
    if (toColumn === 'done') {
      destroyTaskTerminalSession(taskId);
      runtime.activeRunId = null;
      if (runtime.run) {
        runtime.run = {
          ...runtime.run,
          status: 'completed',
          phase: 'validate',
          phaseLabel: PHASE_LABELS.validate,
          reviewState: 'accepted',
          updatedAt: new Date().toISOString(),
          pendingInputRequest: null,
        };
      }
      saveTaskRuntime(taskId, runtime);
    } else if (toColumn === 'todo') {
      destroyTaskTerminalSession(taskId);
      runtime.activeRunId = null;
      runtime.executionContext = null;
      if (runtime.run?.status === 'running') {
        runtime.run.status = 'interrupted';
      }
      saveTaskRuntime(taskId, runtime);
    } else if (fromColumn === 'review' && toColumn === 'doing') {
      runtime.activeRunId = null;
      runtime.run = null;
      runtime.validationStatus = null;
      saveTaskRuntime(taskId, runtime);
    }
    res.json(enrichTask(task));
  } catch (error) {
    if (error.message === 'not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'invalid columns' || error.message === 'cannot move directly into review') {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:column/:filename/update', (req, res) => {
  const { column, filename } = req.params;
  const { fields, body } = req.body;
  const storageColumn = backlog.getStorageColumnForBoardColumn(column);

  try {
    const task = backlog.updateTaskFields(BACKLOG_ROOT, storageColumn, filename, fields || {}, body);
    res.json(enrichTask(task));
  } catch (error) {
    if (error.message === 'not found') {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:column/:filename/assignment', (req, res) => {
  const { column, filename } = req.params;
  const { phase, agentId, model, effort } = req.body || {};
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  if (task.storageColumn !== 'doing' || task.boardColumn === 'review') {
    return res.status(400).json({ error: 'agent assignment is only available for tasks in doing' });
  }
  if (phase && !PHASE_KEYS.includes(phase)) {
    return res.status(400).json({ error: 'invalid phase' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  const targetPhases = phase ? [phase] : PHASE_KEYS;

  for (const phaseKey of targetPhases) {
    const currentSelection = getPhaseSelection(runtime.phaseConfig, phaseKey);
    const nextSelection = {
      agentId: agentId !== undefined ? (agentId || null) : currentSelection.agentId,
      model: model !== undefined ? (model || null) : currentSelection.model,
      effort: effort !== undefined ? (effort || null) : currentSelection.effort,
    };

    if (nextSelection.agentId && !AGENT_IDS.has(nextSelection.agentId)) {
      return res.status(400).json(buildPhaseValidationIssue(phaseKey, 'agent', `invalid agent for ${PHASE_LABELS[phaseKey]}`, nextSelection.agentId));
    }

    if (!nextSelection.agentId) {
      runtime.phaseConfig[phaseKey] = {
        agentId: null,
        model: null,
        effort: null,
      };
      continue;
    }

    const validation = validatePhaseSelection(phaseKey, nextSelection, { requireAgent: false });
    if (validation.issue) {
      return res.status(400).json(validation.issue);
    }

    runtime.phaseConfig[phaseKey] = normalizeSelectionForAgent(validation.agent, nextSelection);
  }

  const planningSelection = primaryPhaseSelection(runtime.phaseConfig);
  runtime.assignedAgent = planningSelection.agentId;
  runtime.model = planningSelection.model;
  runtime.effort = planningSelection.effort;
  saveTaskRuntime(taskId, runtime);
  res.json(taskRuntimeForResponse(taskId));
});

app.post('/api/tasks/:column/:filename/plan-draft', async (req, res) => {
  const { column, filename } = req.params;
  const {
    additionalInput = '',
    agentId = null,
    model = null,
    effort = null,
    draftPlanMode = null,
    secondOpinionEnabled = false,
    secondOpinionAgentId = null,
    secondOpinionModel = null,
    secondOpinionEffort = null,
  } = req.body || {};
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  if (task.storageColumn === 'done') {
    return res.status(400).json({ error: 'plan drafting is not available for done tasks' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  if (runtime.activeDraftPlanRunId && ACTIVE_RUNS.has(runtime.activeDraftPlanRunId)) {
    return res.status(409).json({ error: 'task already has an active plan draft run' });
  }
  const normalizedInput = String(additionalInput || '').trim();
  if (!normalizedInput) {
    return res.status(400).json({ error: 'additional input is required to draft or regenerate a plan' });
  }

  const nextSelection = {
    agentId: agentId || runtime.draftPlanConfig?.agentId || getPhaseSelection(runtime.phaseConfig, 'planning').agentId,
    model: model || runtime.draftPlanConfig?.model || getPhaseSelection(runtime.phaseConfig, 'planning').model,
    effort: effort || runtime.draftPlanConfig?.effort || getPhaseSelection(runtime.phaseConfig, 'planning').effort,
  };
  const agent = getAgentById(nextSelection.agentId);
  if (!agent) {
    return res.status(400).json({ error: 'invalid plan draft agent' });
  }
  const normalizedSelection = normalizeSelectionForAgent(agent, nextSelection);
  if (!normalizedSelection.agentId) {
    return res.status(400).json({ error: 'invalid plan draft agent' });
  }
  let secondOpinionSelection = null;
  if (secondOpinionEnabled) {
    const candidateSecondOpinion = {
      agentId: secondOpinionAgentId || runtime.secondOpinionConfig?.agentId,
      model: secondOpinionModel || runtime.secondOpinionConfig?.model,
      effort: secondOpinionEffort || runtime.secondOpinionConfig?.effort,
    };
    const secondOpinionValidation = validateAgentSelection(candidateSecondOpinion, 'second-opinion');
    if (secondOpinionValidation.issue) {
      return res.status(400).json(secondOpinionValidation.issue);
    }
    secondOpinionSelection = secondOpinionValidation.normalized;
  }

  try {
    const planInfo = backlog.ensurePrimaryPlanFile(BACKLOG_ROOT, column, filename);
    const currentPlan = safeReadText(path.join(BACKLOG_ROOT, planInfo.planRef));
    const currentPlanBody = splitPlanFeedbackHistory(currentPlan).body.trim();
    const resolvedDraftPlanMode = draftPlanMode
      ? normalizeDraftPlanMode(draftPlanMode)
      : currentPlanBody && currentPlanBody !== `# ${planInfo.task.title || filename}` ? 'fast_refine' : 'deep_draft';
    runtime.draftPlanConfig = normalizedSelection;
    runtime.draftPlanMode = resolvedDraftPlanMode;
    if (secondOpinionSelection) {
      runtime.secondOpinionConfig = secondOpinionSelection;
    }
    if (planInfo.created && !runtime.planState) {
      runtime.planState = 'todo';
    }
    saveTaskRuntime(taskId, runtime);

    const draftRun = await createDraftPlanRun(
      planInfo.task,
      normalizedSelection,
      planInfo.planRef,
      normalizedInput,
      resolvedDraftPlanMode,
      Boolean(secondOpinionEnabled),
      secondOpinionSelection,
    );

    setImmediate(() => {
      executeDraftPlanRun(draftRun, planInfo.task, planInfo.planRef, normalizedInput).catch((error) => {
        logSystem(draftRun, `[draft-plan] unexpected failure: ${error.message}`, null, 'error');
        draftRun.finishedAt = new Date().toISOString();
        setRunState(draftRun, {
          status: 'failed',
          errorMessage: error.message,
          pendingInputRequest: null,
        });
        ACTIVE_RUNS.delete(draftRun.id);
        persistRunState(draftRun);
      });
    });

    return res.json({
      planPath: planInfo.planRef,
      created: planInfo.created,
      run: summarizeRun(draftRun),
      runtime: taskRuntimeForResponse(taskId),
    });
  } catch (error) {
    if (error.message === 'not found') {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:column/:filename/plan/approve', (req, res) => {
  const { column, filename } = req.params;
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!Array.isArray(task.plans_files) || task.plans_files.length === 0) {
    return res.status(400).json({ error: 'task has no linked plan file to approve' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  const approvedAt = new Date().toISOString();
  const primaryPlanRef = task.plans_files[0];
  try {
    const currentPlan = safeReadText(path.join(BACKLOG_ROOT, primaryPlanRef));
    writePlanFile(BACKLOG_ROOT, primaryPlanRef, appendPlanFeedbackEntry(currentPlan, {
      timestamp: approvedAt,
      iteration: runtime.planGenerationIteration || 1,
      kind: 'human_approval',
      status: 'approved',
      feedback: 'Plan approved by human reviewer.',
    }));
    runtime.planState = 'approved';
    runtime.planApprovedAt = approvedAt;
    runtime.planApprovedBy = 'human';
    saveTaskRuntime(taskId, runtime);
    return res.json(taskRuntimeForResponse(taskId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:column/:filename/plan/recall', (req, res) => {
  const { column, filename } = req.params;
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);

  if (runtime.planState !== 'approved') {
    return res.status(400).json({ error: 'plan is not approved' });
  }

  try {
    // Stop any active implementation run
    if (runtime.activeRunId && ACTIVE_RUNS.has(runtime.activeRunId)) {
      const runState = ACTIVE_RUNS.get(runtime.activeRunId);
      runState.stopRequested = true;
      setRunState(runState, {
        status: 'stopping',
        waitingForInput: false,
        pendingInputRequest: null,
      });
      appendEvent(runState, 'system', { message: 'Stopping run — plan recalled by human reviewer.' });
      if (runState.currentChild) {
        try { runState.currentChild.kill('SIGTERM'); } catch { /* ignore */ }
      } else {
        runState.finishedAt = new Date().toISOString();
        setRunState(runState, { status: 'stopped', waitingForInput: false, pendingInputRequest: null, errorMessage: null });
        ACTIVE_RUNS.delete(runState.id);
        persistRunState(runState);
      }
    }

    runtime.planState = 'generated';
    runtime.planApprovedAt = null;
    runtime.planApprovedBy = null;
    saveTaskRuntime(taskId, runtime);
    return res.json(taskRuntimeForResponse(taskId));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/tasks/:column/:filename/start', (req, res) => {
  const { column, filename } = req.params;
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  if (task.storageColumn !== 'doing' || task.boardColumn === 'review') {
    return res.status(400).json({ error: 'only tasks in doing can be started' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  if (derivePlanState(task, runtime) !== 'approved') {
    return res.status(400).json({ error: 'implementation pipeline requires an approved plan' });
  }
  for (const phaseKey of PHASE_KEYS) {
    const validation = validatePhaseSelection(phaseKey, getPhaseSelection(runtime.phaseConfig, phaseKey), {
      requireAgent: true,
    });
    if (validation.issue) {
      return res.status(400).json(validation.issue);
    }
  }
  saveTaskRuntime(taskId, runtime);
  if (runtime.activeRunId && ACTIVE_RUNS.has(runtime.activeRunId)) {
    return res.status(409).json({ error: 'task already has an active run' });
  }

  if (isResumableRun(runtime.run)) {
    try {
      const resumedRun = hydrateRunState(runtime.run.id, taskId);

      if (resumedRun.pendingInputRequest) {
        setRunState(resumedRun, {
          status: 'awaiting_input',
          waitingForInput: true,
          errorMessage: null,
        });
        appendEvent(resumedRun, 'system', {
          message: `Run resumed and is waiting for input in ${PHASE_LABELS[resumedRun.phase] || resumedRun.phase}.`,
        });
        return res.json({ run: summarizeRun(resumedRun) });
      }

      setRunState(resumedRun, {
        status: 'queued',
        waitingForInput: false,
        errorMessage: null,
      });
      appendEvent(resumedRun, 'system', {
        message: `Resuming run from ${PHASE_LABELS[resumedRun.phase] || resumedRun.phase}.`,
      });

      setImmediate(() => {
        executeRun(resumedRun, {
          resume: true,
          context: {
            currentPhase: resumedRun.phase,
          },
        }).catch((error) => {
          logSystem(resumedRun, `[run] unexpected failure while resuming: ${error.message}`, null, 'error');
          setRunState(resumedRun, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            errorMessage: error.message,
            pendingInputRequest: null,
          });
          ACTIVE_RUNS.delete(resumedRun.id);
          persistRunState(resumedRun);
        });
      });

      return res.json({ run: summarizeRun(resumedRun) });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  const runState = createRun(task, primaryPhaseSelection(runtime.phaseConfig).agentId);
  setImmediate(() => {
    executeRun(runState).catch((error) => {
      logSystem(runState, `[run] unexpected failure: ${error.message}`, null, 'error');
      setRunState(runState, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: error.message,
        pendingInputRequest: null,
      });
      ACTIVE_RUNS.delete(runState.id);
      persistRunState(runState);
    });
  });

  res.json({ run: summarizeRun(runState) });
});

app.post('/api/tasks/:column/:filename/restart', (req, res) => {
  const { column, filename } = req.params;
  const task = readTaskForBoardColumn(column, filename);
  if (!task) {
    return res.status(404).json({ error: 'not found' });
  }
  if (task.storageColumn !== 'doing' || task.boardColumn === 'review') {
    return res.status(400).json({ error: 'only tasks in doing can be restarted' });
  }

  const taskId = backlog.taskFilenameToId(filename);
  const runtime = getTaskRuntime(taskId);
  if (derivePlanState(task, runtime) !== 'approved') {
    return res.status(400).json({ error: 'implementation pipeline requires an approved plan' });
  }
  for (const phaseKey of PHASE_KEYS) {
    const validation = validatePhaseSelection(phaseKey, getPhaseSelection(runtime.phaseConfig, phaseKey), {
      requireAgent: true,
    });
    if (validation.issue) {
      return res.status(400).json(validation.issue);
    }
  }
  if (runtime.activeRunId && ACTIVE_RUNS.has(runtime.activeRunId)) {
    return res.status(409).json({ error: 'task already has an active run' });
  }

  const runState = createRun(task, primaryPhaseSelection(runtime.phaseConfig).agentId);
  appendEvent(runState, 'system', { message: 'Restarting the implementation pipeline from Agent Plan.' });
  setImmediate(() => {
    executeRun(runState).catch((error) => {
      logSystem(runState, `[run] unexpected failure while restarting: ${error.message}`, null, 'error');
      setRunState(runState, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: error.message,
        pendingInputRequest: null,
      });
      ACTIVE_RUNS.delete(runState.id);
      persistRunState(runState);
    });
  });

  res.json({ run: summarizeRun(runState) });
});

app.post('/api/runs/:runId/input', (req, res) => {
  try {
    const runState = getActiveRunOrThrow(req.params.runId);
    const { requestId, answer } = req.body;

    if (runState.status !== 'awaiting_input' || !runState.pendingInputRequest) {
      return res.status(409).json({ error: 'run is not awaiting input' });
    }
    if (requestId !== runState.pendingInputRequest.requestId) {
      return res.status(400).json({ error: 'request_id mismatch' });
    }
    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'answer is required' });
    }

    const request = runState.pendingInputRequest;
    runState.inputHistory.push({
      request,
      answer: answer.trim(),
      submittedAt: new Date().toISOString(),
    });
    appendEvent(runState, 'input_response', {
      requestId: request.requestId,
      answer: answer.trim(),
    });

    const resumeContext = runState.pendingResumeContext || {
      currentPhase: request.phase,
    };

    setRunState(runState, {
      status: 'queued',
      waitingForInput: false,
      pendingInputRequest: null,
      errorMessage: null,
    });
    appendEvent(runState, 'system', {
      message: `Resuming ${PHASE_LABELS[resumeContext.currentPhase] || resumeContext.currentPhase} after human input.`,
    });
    runState.pendingResumeContext = null;

    setImmediate(() => {
      executeRun(runState, {
        resume: true,
        context: resumeContext,
      }).catch((error) => {
        logSystem(runState, `[run] unexpected failure while resuming: ${error.message}`, null, 'error');
        setRunState(runState, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          errorMessage: error.message,
          pendingInputRequest: null,
        });
        ACTIVE_RUNS.delete(runState.id);
        persistRunState(runState);
      });
    });

    res.json({ run: summarizeRun(runState) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/api/runs/:runId/review-decision', (req, res) => {
  try {
    const meta = readRunMetaOrThrow(req.params.runId);
    const { decision, feedback } = req.body;

    if (!['accept', 'request_changes'].includes(decision)) {
      return res.status(400).json({ error: 'invalid decision' });
    }
    if (decision === 'request_changes' && (typeof feedback !== 'string' || !feedback.trim())) {
      return res.status(400).json({ error: 'feedback is required' });
    }
    if (meta.status !== 'completed' || meta.phase !== 'validate') {
      return res.status(409).json({ error: 'run is not awaiting manual validation' });
    }

    const runState = hydrateRunState(meta.id, meta.taskId);

    if (decision === 'accept') {
      setRunState(runState, {
        reviewState: 'accepted',
      });
      appendEvent(runState, 'review_decision', {
        decision: 'accept',
        message: 'Manual validation accepted by reviewer.',
      });
      ACTIVE_RUNS.delete(runState.id);
      persistRunState(runState);
      return res.json({ run: summarizeRun(runState) });
    }

    const normalizedFeedback = feedback.trim();
    const rejectedIteration = runState.iteration || 1;
    const historyEntry = {
      iteration: rejectedIteration,
      feedback: normalizedFeedback,
      createdAt: new Date().toISOString(),
    };

    runState.reviewFeedbackHistory.push(historyEntry);
    runState.latestReviewerFeedback = normalizedFeedback;
    runState.reviewState = 'changes_requested';
    runState.iteration = rejectedIteration + 1;
    runState.validationStatus = null;
    runState.docsStatus = null;
    runState.finishedAt = null;
    runState.errorMessage = null;
    runState.pendingInputRequest = null;
    runState.pendingResumeContext = null;
    runState.currentPhaseContext = { currentPhase: 'planning' };
    runState.stopRequested = false;

    backlog.returnTaskToDoingFromReview(BACKLOG_ROOT, runState.filename);

    appendEvent(runState, 'review_feedback', {
      iteration: rejectedIteration,
      feedback: normalizedFeedback,
      message: normalizedFeedback,
    });
    appendEvent(runState, 'review_decision', {
      decision: 'request_changes',
      iteration: rejectedIteration,
      message: 'Manual validation rejected. Starting a new iteration from Agent Plan.',
    });
    appendEvent(runState, 'iteration_started', {
      iteration: runState.iteration,
      message: `Iteration ${runState.iteration} started after reviewer feedback.`,
    });

    setRunState(runState, {
      status: 'queued',
      phase: 'planning',
      waitingForInput: false,
      pendingInputRequest: null,
      reviewState: 'changes_requested',
    });

    setImmediate(() => {
      executeRun(runState, {
        resume: true,
        context: {
          currentPhase: 'planning',
        },
      }).catch((error) => {
        logSystem(runState, `[run] unexpected failure while restarting after review feedback: ${error.message}`, null, 'error');
        setRunState(runState, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          errorMessage: error.message,
          pendingInputRequest: null,
        });
        ACTIVE_RUNS.delete(runState.id);
        persistRunState(runState);
      });
    });

    return res.json({ run: summarizeRun(runState) });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.post('/api/runs/:runId/stop', (req, res) => {
  try {
    const runState = getActiveRunOrThrow(req.params.runId);
    const preservedInputRequest = runState.currentChild ? null : runState.pendingInputRequest;
    runState.stopRequested = true;
    setRunState(runState, {
      status: 'stopping',
      waitingForInput: false,
      pendingInputRequest: preservedInputRequest,
    });
    appendEvent(runState, 'system', { message: 'Stopping run on user request.' });

    if (runState.currentChild) {
      try {
        runState.currentChild.kill('SIGTERM');
      } catch {
        // ignore
      }
    } else {
      runState.finishedAt = new Date().toISOString();
      setRunState(runState, {
        status: 'stopped',
        waitingForInput: false,
        pendingInputRequest: preservedInputRequest,
        errorMessage: null,
      });
      ACTIVE_RUNS.delete(runState.id);
      persistRunState(runState);
      for (const client of runState.clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      runState.clients.clear();
    }

    res.json({ run: summarizeRun(runState) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/api/runs/:runId', (req, res) => {
  try {
    res.json(readRunMetaOrThrow(req.params.runId));
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/api/runs/:runId/events', (req, res) => {
  try {
    const meta = readRunMetaOrThrow(req.params.runId);
    res.json({
      run: meta,
      events: readRunEvents(req.params.runId),
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.get('/api/runs/:runId/terminal', (req, res) => {
  const logPath = runTerminalPath(req.params.runId);
  if (!fs.existsSync(logPath)) {
    return res.status(404).json({ error: 'run log not found' });
  }
  res.type('text/plain').send(fs.readFileSync(logPath, 'utf-8'));
});

app.get('/api/runs/:runId/artifacts/:name', (req, res) => {
  const filePath = runArtifactPath(req.params.runId, req.params.name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'artifact not found' });
  }
  res.type('text/plain').send(fs.readFileSync(filePath, 'utf-8'));
});

app.get('/api/plans/*', (req, res) => {
  const requestedPath = req.params[0];
  const resolved = path.resolve(BACKLOG_ROOT, requestedPath);
  if (!resolved.startsWith(BACKLOG_ROOT + path.sep)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'not found' });
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    res.json({
      path: requestedPath,
      raw,
      html: marked.parse(raw),
      feedbackHistory: parsePlanFeedbackHistory(raw),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plans/update', (req, res) => {
  const { path: planPathRef, content } = req.body;
  if (typeof planPathRef !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: 'invalid request' });
  }

  const resolved = path.resolve(BACKLOG_ROOT, planPathRef);
  if (!resolved.startsWith(BACKLOG_ROOT + path.sep)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'not found' });
  }

  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    markPlanEditedRequiresApproval(planPathRef);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssTerminal = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  const terminalMatch = requestUrl.pathname.match(/^\/ws\/tasks\/([^/]+)\/terminal$/);
  if (terminalMatch) {
    request.taskId = decodeURIComponent(terminalMatch[1]);
    wssTerminal.handleUpgrade(request, socket, head, (ws) => {
      wssTerminal.emit('connection', ws, request);
    });
    return;
  }

  // Run events WebSocket: /ws/runs/:runId
  const match = requestUrl.pathname.match(/^\/ws\/runs\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }

  request.runId = match[1];
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wssTerminal.on('connection', (ws, request) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const cwd = requestUrl.searchParams.get('cwd') || BACKLOG_ROOT;
  const taskId = request.taskId || requestUrl.searchParams.get('taskId');
  if (!taskId) {
    ws.close();
    return;
  }

  const session = getOrCreateTaskTerminalSession(taskId, cwd);
  session.clients.add(ws);

  if (session.history && ws.readyState === ws.OPEN) {
    try {
      ws.send(session.history);
    } catch {
      // ignore initial replay failures
    }
  }

  ws.on('message', (msg) => {
    const str = msg.toString();
    if (str.startsWith('\x01resize:')) {
      const parts = str.slice(8).split(',');
      const cols = parseInt(parts[0], 10);
      const rows = parseInt(parts[1], 10);
      if (cols > 0 && rows > 0) {
        session.cols = cols;
        session.rows = rows;
        try {
          session.term.resize(cols, rows);
        } catch {
          // ignore resize failures
        }
      }
      return;
    }
    session.term.write(str);
  });

  ws.on('close', () => {
    session.clients.delete(ws);
  });
});

wss.on('connection', (ws, request) => {
  const runId = request.runId;
  const runState = ACTIVE_RUNS.get(runId);
  const meta = safeReadJson(runMetaPath(runId), null);
  if (!meta) {
    ws.close();
    return;
  }

  ws.send(JSON.stringify({
    type: 'replay',
    run: meta,
    events: readRunEvents(runId),
  }));

  if (!runState) {
    return;
  }

  runState.clients.add(ws);

  ws.on('close', () => {
    runState.clients.delete(ws);
  });
});

function displayHost(host) {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host;
}

function startServer(options = {}) {
  const port = options.port === undefined ? PORT : Number(options.port);
  const host = options.host || HOST;
  return server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${displayHost(host)}:${actualPort}`;
    if (typeof options.onListen === 'function') {
      options.onListen({ server, url, port: actualPort, host });
    } else {
      console.log(`${setupMode ? 'Moirai setup wizard' : 'Moirai board'} running at ${url}`);
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  startServer,
  CONFIG,
  PROJECT_ROOT,
};
