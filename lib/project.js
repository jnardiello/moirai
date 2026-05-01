const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  DEFAULT_CONFIG,
  deepMerge,
  loadBoardConfig,
  moiraiConfigDir,
  moiraiConfigPath,
  moiraiLocalConfigPath,
  legacyConfigPath,
  writeJson,
} = require('./config');

const REQUIRED_BOARD_DIRS = [
  'todos/todo',
  'todos/doing',
  'todos/done',
  'plans/todo',
  'plans/doing',
  'plans/done',
];

const GITIGNORE_LOCAL_LINES = [
  '.moirai/runtime/',
  '.moirai/local.json',
];

function resolveProjectRoot(root = process.cwd()) {
  return path.resolve(root);
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function isGitRepo(root) {
  return pathExists(path.join(root, '.git'));
}

function safeReadConfig(projectRoot) {
  const configPath = moiraiConfigPath(projectRoot);
  if (!pathExists(configPath)) {
    return { hasConfig: false, valid: false, error: null, config: null };
  }

  try {
    return {
      hasConfig: true,
      valid: true,
      error: null,
      config: loadBoardConfig(projectRoot),
    };
  } catch (error) {
    return {
      hasConfig: true,
      valid: false,
      error: error.message,
      config: null,
    };
  }
}

function inspectBoardDirs(projectRoot) {
  const dirs = REQUIRED_BOARD_DIRS.map((relativePath) => ({
    path: relativePath,
    exists: pathExists(path.join(projectRoot, relativePath)),
  }));
  const missingDirs = dirs.filter((entry) => !entry.exists).map((entry) => entry.path);
  const existingDirs = dirs.filter((entry) => entry.exists).map((entry) => entry.path);
  const status = missingDirs.length === 0
    ? 'complete'
    : existingDirs.length > 0 ? 'partial' : 'fresh';

  return {
    status,
    missingDirs,
    existingDirs,
    requiredDirs: REQUIRED_BOARD_DIRS,
  };
}

function detectProject(root = process.cwd()) {
  const projectRoot = resolveProjectRoot(root);
  const configStatus = safeReadConfig(projectRoot);
  const structure = inspectBoardDirs(projectRoot);
  const hasLegacyConfig = pathExists(legacyConfigPath(projectRoot));

  let recommendedAction = 'init';
  if (configStatus.hasConfig && !configStatus.valid) {
    recommendedAction = 'repair_config';
  } else if (configStatus.valid && structure.status === 'complete') {
    recommendedAction = 'open';
  } else if (structure.status === 'complete') {
    recommendedAction = 'adopt';
  } else if (structure.status === 'partial') {
    recommendedAction = 'repair';
  }

  return {
    projectRoot,
    configPath: moiraiConfigPath(projectRoot),
    localConfigPath: moiraiLocalConfigPath(projectRoot),
    configDir: moiraiConfigDir(projectRoot),
    hasConfig: configStatus.hasConfig,
    configValid: configStatus.valid,
    configError: configStatus.error,
    hasLegacyConfig,
    legacyConfigPath: legacyConfigPath(projectRoot),
    structure,
    recommendedAction,
  };
}

function suggestRepositories(root = process.cwd()) {
  const projectRoot = resolveProjectRoot(root);
  const repos = { backlog: '.' };
  const currentName = path.basename(projectRoot);
  if (isGitRepo(projectRoot) && currentName !== 'backlog') {
    repos[currentName] = '.';
  }

  const parent = path.dirname(projectRoot);
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const siblingPath = path.join(parent, entry.name);
      if (siblingPath === projectRoot || !isGitRepo(siblingPath)) {
        continue;
      }
      repos[entry.name] = path.relative(projectRoot, siblingPath) || '.';
    }
  } catch {
    // Sibling discovery is a convenience only.
  }

  return repos;
}

function normalizeRepositories(repositories, projectRoot) {
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
    return suggestRepositories(projectRoot);
  }

  const normalized = {};
  for (const [name, repoPath] of Object.entries(repositories)) {
    if (!/^[\w.-]+$/.test(name) || typeof repoPath !== 'string' || !repoPath.trim()) {
      continue;
    }
    normalized[name] = repoPath.trim();
  }
  if (!normalized.backlog) {
    normalized.backlog = '.';
  }
  return normalized;
}

function buildProjectConfig(projectRoot, options = {}) {
  return deepMerge(DEFAULT_CONFIG, {
    boardRoot: '.',
    repoBaseDir: '.',
    runtimeDir: '.moirai/runtime',
    worktreeRoot: '.moirai/runtime/worktrees',
    repos: normalizeRepositories(options.repositories, projectRoot),
    server: {
      host: options.host || '127.0.0.1',
      port: Number(options.port) || 3001,
    },
  });
}

function ensureBoardDirs(projectRoot) {
  for (const relativePath of REQUIRED_BOARD_DIRS) {
    fs.mkdirSync(path.join(projectRoot, relativePath), { recursive: true });
  }
}

function ensureLocalIgnore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = pathExists(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = existing.split('\n');
  const additions = GITIGNORE_LOCAL_LINES.filter((line) => !lines.includes(line));
  if (additions.length === 0) {
    return { gitignorePath, updated: false, added: [] };
  }

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${prefix}${additions.join('\n')}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf-8');
  return { gitignorePath, updated: true, added: additions };
}

function initializeProject(root = process.cwd(), options = {}) {
  const projectRoot = resolveProjectRoot(root);
  ensureBoardDirs(projectRoot);
  fs.mkdirSync(moiraiConfigDir(projectRoot), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.moirai', 'runtime'), { recursive: true });

  const configPath = moiraiConfigPath(projectRoot);
  const shouldWriteConfig = options.overwriteConfig || !pathExists(configPath);
  if (shouldWriteConfig) {
    writeJson(configPath, buildProjectConfig(projectRoot, options));
  }

  const gitignore = ensureLocalIgnore(projectRoot);
  return {
    projectRoot,
    configPath,
    wroteConfig: shouldWriteConfig,
    gitignore,
    detection: detectProject(projectRoot),
  };
}

function commandExists(command) {
  const result = spawnSync('which', [command], {
    encoding: 'utf-8',
    timeout: 4000,
  });
  return result.status === 0 && Boolean((result.stdout || '').trim());
}

function doctorProject(root = process.cwd()) {
  const detection = detectProject(root);
  const issues = [];
  const warnings = [];
  let config = null;

  if (!detection.hasConfig) {
    issues.push(`Missing ${path.relative(detection.projectRoot, detection.configPath)}.`);
  } else if (!detection.configValid) {
    issues.push(`Invalid config: ${detection.configError}`);
  } else {
    config = loadBoardConfig(detection.projectRoot);
  }

  for (const missingDir of detection.structure.missingDirs) {
    issues.push(`Missing ${missingDir}/.`);
  }

  if (config) {
    for (const [repoName, repoPath] of Object.entries(config.repos || {})) {
      if (!pathExists(repoPath)) {
        issues.push(`Repository "${repoName}" does not exist at ${repoPath}.`);
      } else if (!pathExists(path.join(repoPath, '.git')) && repoName !== 'backlog') {
        warnings.push(`Repository "${repoName}" is not a git repository: ${repoPath}.`);
      }
    }

    for (const [agentId, agentConfig] of Object.entries(config.agents || {})) {
      const command = agentConfig.command || agentId;
      if (!commandExists(command)) {
        warnings.push(`Agent command "${command}" for ${agentId} was not found on PATH.`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    detection,
    config,
  };
}

module.exports = {
  GITIGNORE_LOCAL_LINES,
  REQUIRED_BOARD_DIRS,
  buildProjectConfig,
  detectProject,
  doctorProject,
  initializeProject,
  resolveProjectRoot,
  suggestRepositories,
};
