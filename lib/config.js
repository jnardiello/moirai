const fs = require('fs');
const path = require('path');

const CONFIG_DIR = '.moirai';
const CONFIG_FILENAME = 'config.json';
const LOCAL_CONFIG_FILENAME = 'local.json';
const LEGACY_CONFIG_FILENAME = 'agent-config.json';

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  boardRoot: '.',
  tasksDir: 'todos',
  plansDir: 'plans',
  runtimeDir: '.moirai/runtime',
  worktreeRoot: '.moirai/runtime/worktrees',
  repoBaseDir: '.',
  defaultBaseBranch: 'master',
  maxReviewAttempts: 2,
  repos: {
    backlog: '.',
  },
  agents: {
    codex: {
      command: 'codex',
    },
    claude: {
      command: 'claude',
    },
    opencode: {
      command: 'opencode',
    },
  },
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function resolvePath(baseDir, relativePath) {
  return path.resolve(baseDir, relativePath);
}

function resolveRepoPath(boardRoot, repoBaseDir, repoPath) {
  if (path.isAbsolute(repoPath)) {
    return repoPath;
  }

  const fromBoardRoot = resolvePath(boardRoot, repoPath);
  const fromRepoBase = resolvePath(repoBaseDir, repoPath);

  if (fs.existsSync(fromBoardRoot)) {
    return fromBoardRoot;
  }
  if (fs.existsSync(fromRepoBase)) {
    return fromRepoBase;
  }

  return fromBoardRoot;
}

function moiraiConfigDir(projectRoot) {
  return path.join(projectRoot, CONFIG_DIR);
}

function moiraiConfigPath(projectRoot) {
  return path.join(moiraiConfigDir(projectRoot), CONFIG_FILENAME);
}

function moiraiLocalConfigPath(projectRoot) {
  return path.join(moiraiConfigDir(projectRoot), LOCAL_CONFIG_FILENAME);
}

function legacyConfigPath(projectRoot) {
  return path.join(projectRoot, LEGACY_CONFIG_FILENAME);
}

function normalizeRepoConfig(merged) {
  return merged.repos || merged.repositories || {};
}

function normalizeBoardConfig(projectRoot, mergedConfig = {}) {
  const root = path.resolve(projectRoot || process.cwd());
  const merged = deepMerge(DEFAULT_CONFIG, mergedConfig);
  const boardRoot = resolvePath(root, merged.boardRoot || '.');

  const config = {
    ...merged,
    projectRoot: root,
    boardRoot,
    configDir: moiraiConfigDir(root),
    configPath: moiraiConfigPath(root),
    localConfigPath: moiraiLocalConfigPath(root),
    runtimeDir: resolvePath(boardRoot, merged.runtimeDir),
    worktreeRoot: resolvePath(boardRoot, merged.worktreeRoot),
    repoBaseDir: resolvePath(boardRoot, merged.repoBaseDir),
    repos: {},
    agents: merged.agents || {},
  };

  for (const [repoName, repoPath] of Object.entries(normalizeRepoConfig(merged))) {
    config.repos[repoName] = resolveRepoPath(boardRoot, config.repoBaseDir, repoPath);
  }
  if (!config.repos.backlog) {
    config.repos.backlog = boardRoot;
  }
  config.repositories = config.repos;

  return config;
}

function loadBoardConfig(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const trackedPath = moiraiConfigPath(root);
  const localPath = moiraiLocalConfigPath(root);
  const legacyPath = legacyConfigPath(root);
  const trackedConfig = fs.existsSync(trackedPath) ? readJson(trackedPath) : readJson(legacyPath);

  const merged = deepMerge(trackedConfig, readJson(localPath));
  return normalizeBoardConfig(root, merged);
}

function saveDiscoveredAgentCatalog(projectRoot, discoveredAgents) {
  const localPath = moiraiLocalConfigPath(path.resolve(projectRoot || process.cwd()));
  const existing = readJson(localPath);
  const next = deepMerge(existing, { agents: discoveredAgents });
  writeJson(localPath, next);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
  DEFAULT_CONFIG,
  deepMerge,
  loadBoardConfig,
  legacyConfigPath,
  moiraiConfigDir,
  moiraiConfigPath,
  moiraiLocalConfigPath,
  normalizeBoardConfig,
  readJson,
  saveDiscoveredAgentCatalog,
  writeJson,
};
