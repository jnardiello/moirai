const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AGENT_DEFINITIONS = {
  codex: {
    id: 'codex',
    label: 'Codex',
    interactive: true,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    interactive: true,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    interactive: true,
  },
};

function supportedAgents(config) {
  return Object.values(AGENT_DEFINITIONS).map((definition) => ({
    id: definition.id,
    label: definition.label,
    command: config.agents?.[definition.id]?.command || definition.id,
    models: normalizeList(config.agents?.[definition.id]?.models || []),
    efforts: normalizeList(config.agents?.[definition.id]?.efforts || []),
    modelCatalog: Array.isArray(config.agents?.[definition.id]?.modelCatalog) ? config.agents[definition.id].modelCatalog : [],
    supportsEffort: normalizeList(config.agents?.[definition.id]?.efforts || []).length > 0,
  }));
}

function normalizeList(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

function runCommand(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...extraEnv,
    },
    timeout: 8000,
    maxBuffer: 24 * 1024 * 1024,
  });

  return {
    ok: !result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function resolveCommandPath(command) {
  const whichResult = spawnSync('which', [command], {
    encoding: 'utf-8',
    env: process.env,
    timeout: 4000,
  });
  const resolved = (whichResult.stdout || '').trim();
  if (!resolved) {
    return null;
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function stringsFromBinary(binaryPath) {
  if (!binaryPath) {
    return '';
  }
  const result = runCommand('strings', [binaryPath]);
  return `${result.stdout}\n${result.stderr}`;
}

function normalizeCodexModels(discovered) {
  const list = normalizeList(discovered);
  const codexModels = list.filter((model) => /-codex(?:-spark)?$/i.test(model));
  const miniModels = list.filter((model) => /(?:-mini|-nano|-pro)$/i.test(model));
  const generalModels = list.filter((model) => /^gpt-/.test(model) && !/-codex(?:-spark)?$/i.test(model));
  const reasoningModels = list.filter((model) => /^o[0-9](?:-mini)?$/i.test(model));

  const preferredReasoning = ['o3', 'o4-mini', 'o4'];
  const normalizedReasoning = preferredReasoning.filter((model) => reasoningModels.includes(model));
  const latestGeneral = generalModels
    .filter((model) => /^gpt-5\.[0-9]+$/i.test(model))
    .sort()
    .slice(-1);

  return normalizeList([
    ...codexModels.sort(),
    ...miniModels.sort(),
    ...latestGeneral,
    ...normalizedReasoning,
  ]);
}

function readCodexModelsCache() {
  const cachePath = path.join(process.env.HOME || '', '.codex', 'models_cache.json');
  if (!fs.existsSync(cachePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

function normalizeClaudeModelName(model) {
  if (typeof model !== 'string' || !model.trim()) {
    return null;
  }

  let normalized = model.trim();
  if (/^(sonnet|opus|haiku)$/i.test(normalized)) {
    return normalized.toLowerCase();
  }

  normalized = normalized.replace(/-v\d+$/i, '');
  normalized = normalized.replace(/^claude-(sonnet|opus|haiku)-(\d+)\.(\d+)$/i, 'claude-$1-$2-$3');
  return normalized;
}

function normalizeClaudeModels(discovered) {
  const list = normalizeList(discovered)
    .map(normalizeClaudeModelName)
    .filter(Boolean);
  const aliases = ['sonnet', 'opus', 'haiku'];
  const latestByFamily = new Map();

  for (const model of list) {
    const familyMatch = model.match(/^claude-(sonnet|opus|haiku)-(.+)$/);
    if (!familyMatch) {
      continue;
    }
    const family = familyMatch[1];
    const current = latestByFamily.get(family);
    if (!current || model > current) {
      latestByFamily.set(family, model);
    }
  }

  return normalizeList([
    ...aliases,
    ...Array.from(latestByFamily.values()).sort(),
  ]);
}

function probeClaudeModel(command, model) {
  const result = runCommand(command, [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    'Reply with exactly: OK',
  ]);
  const output = `${result.stdout}\n${result.stderr}`;

  if (/authentication_failed|Not logged in/i.test(output)) {
    return null;
  }
  if (/selected model .* may not exist|invalid_request/i.test(output)) {
    return false;
  }
  if (/"type":"assistant"/.test(output) && /"result":"OK"/.test(output)) {
    return true;
  }
  return null;
}

function parseCodexCatalog(command, persisted = {}) {
  const help = runCommand(command, ['exec', '--help']);
  const configPath = path.join(process.env.HOME || '', '.codex', 'config.toml');
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const binaryText = stringsFromBinary(resolveCommandPath(command));
  const cachedModels = readCodexModelsCache();

  const visibleCatalog = cachedModels
    .filter((model) => /^gpt-|^o[0-9]/.test(model.slug || ''))
    .filter((model) => model.visibility === 'list')
    .sort((left, right) => (left.priority || 999) - (right.priority || 999))
    .map((model) => ({
      slug: model.slug,
      label: model.display_name || model.slug,
      efforts: normalizeList((model.supported_reasoning_levels || []).map((level) => level.effort)),
      defaultEffort: model.default_reasoning_level || null,
    }));

  const discoveredModels = [
    ...((help.stdout + help.stderr).match(/model="([^"]+)"/g) || []).map((entry) => entry.match(/"([^"]+)"/)?.[1]).filter(Boolean),
    ...((configText.match(/^model\s*=\s*"([^"]+)"/m) || []).slice(1)),
    ...((binaryText.match(/gpt-[0-9]+\.[0-9]+(?:-[a-z0-9]+)*(?:-codex(?:-spark)?)?|o[0-9](?:-mini)?/g) || [])),
    ...visibleCatalog.map((model) => model.slug),
  ];
  const models = normalizeCodexModels(discoveredModels);

  const discoveredEfforts = normalizeList([
    ...((configText.match(/(?:model_reasoning_effort|plan_mode_reasoning_effort)\s*=\s*"([^"]+)"/g) || []).map((entry) => entry.match(/"([^"]+)"/)?.[1]).filter(Boolean)),
    ...((binaryText.match(/\bxhigh\b|\bhigh\b|\bmedium\b|\blow\b/g) || [])),
    ...visibleCatalog.flatMap((model) => model.efforts),
  ]);
  const efforts = discoveredEfforts.length > 0 ? discoveredEfforts : normalizeList(persisted.efforts || []);

  return {
    models: models.length > 0 ? models : normalizeList(persisted.models || []),
    efforts,
    modelCatalog: visibleCatalog,
    supportsEffort: efforts.length > 0,
  };
}

function parseClaudeCatalog(command, persisted = {}) {
  const help = runCommand(command, ['--help']);
  const helpText = `${help.stdout}\n${help.stderr}`;
  const binaryText = stringsFromBinary(resolveCommandPath(command));
  const persistedModels = normalizeList(persisted.models || [])
    .map(normalizeClaudeModelName)
    .filter(Boolean);

  const discoveredModels = [
    ...((helpText.match(/'([^']+)'/g) || []).map((entry) => entry.replace(/^'|'$/g, '')).filter((value) => /sonnet|opus|haiku|claude-/i.test(value))),
    ...((binaryText.match(/claude-(?:sonnet|opus|haiku)(?:-[0-9A-Za-z.-]+)?/g) || [])),
    ...persistedModels,
  ];
  const normalizedModels = normalizeClaudeModels(discoveredModels);
  const aliases = ['sonnet', 'opus', 'haiku'].filter((alias) => normalizedModels.includes(alias) || persistedModels.includes(alias));
  const fullNames = normalizedModels.filter((model) => !aliases.includes(model));
  const models = normalizeList([
    ...aliases,
    ...fullNames,
  ]);

  const effortMatch = helpText.match(/--effort <level>[^\n]*\(([^)]+)\)/);
  const discoveredEfforts = normalizeList(effortMatch ? effortMatch[1].split(',').map((part) => part.trim()) : []);
  const efforts = discoveredEfforts.length > 0 ? discoveredEfforts : normalizeList(persisted.efforts || []);

  return {
    models: models.length > 0 ? models : normalizeList(persisted.models || []),
    efforts,
    modelCatalog: [],
    supportsEffort: efforts.length > 0,
  };
}

function parseOpenCodeCatalog(command, persisted = {}) {
  const tempEnv = {
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: '/tmp/opencode-cache',
    HOME: '/tmp/opencode-home',
  };

  const modelsResult = runCommand(command, ['models'], tempEnv);
  const helpResult = runCommand(command, ['run', '--help'], tempEnv);

  const modelLines = modelsResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^ERROR\b/i.test(line) && !/migration/i.test(line));

  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  const variantMatch = helpText.match(/variant .*?e\.g\.,\s*([^)]+)/i);

  const efforts = normalizeList([
    ...(variantMatch ? variantMatch[1].split(',').map((part) => part.trim()) : []),
    ...(persisted.efforts || []),
  ]);

  return {
    models: normalizeList([...modelLines, ...(persisted.models || [])]),
    efforts,
    modelCatalog: [],
    supportsEffort: efforts.length > 0,
  };
}

function discoverAgentCatalog(config) {
  const discovered = {};

  for (const definition of Object.values(AGENT_DEFINITIONS)) {
    const persisted = config.agents?.[definition.id] || {};
    const command = persisted.command || definition.id;
    let catalog = {
      models: normalizeList(persisted.models || []),
      efforts: normalizeList(persisted.efforts || []),
      supportsEffort: normalizeList(persisted.efforts || []).length > 0,
    };

    try {
      if (definition.id === 'codex') {
        catalog = parseCodexCatalog(command, persisted);
      } else if (definition.id === 'claude') {
        catalog = parseClaudeCatalog(command, persisted);
      } else if (definition.id === 'opencode') {
        catalog = parseOpenCodeCatalog(command, persisted);
      }
    } catch {
      // Keep persisted fallback if discovery fails.
    }

    discovered[definition.id] = {
      ...persisted,
      command,
      models: catalog.models,
      efforts: catalog.efforts,
      modelCatalog: catalog.modelCatalog || [],
      supportsEffort: catalog.supportsEffort,
      lastRefreshedAt: new Date().toISOString(),
    };
  }

  return discovered;
}

function buildAddDirArgs(flag, directories) {
  const args = [];
  for (const directory of directories) {
    args.push(flag, directory);
  }
  return args;
}

function buildAgentCommand(agentId, config, options) {
  const {
    phase,
    cwd,
    prompt,
    addDirs = [],
    runtimeDir,
    model,
    effort,
  } = options;

  const command = config.agents?.[agentId]?.command || agentId;
  const uniqueAddDirs = [...new Set([cwd, runtimeDir, ...addDirs].filter(Boolean))];
  const opencodeCacheRoot = path.join(runtimeDir, 'cache', 'opencode');
  const baseEnv = {
    NO_COLOR: '1',
    CI: '1',
    TERM: 'dumb',
  };

  if (agentId === 'codex') {
    const args = ['exec', '--full-auto', '--color', 'never'];
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `reasoning_effort="${effort}"`);
    args.push('-C', cwd, ...buildAddDirArgs('--add-dir', uniqueAddDirs), '-');
    return {
      stdinPrompt: true,
      command,
      args,
      env: baseEnv,
    };
  }

  if (agentId === 'claude') {
    const args = ['--print', '--permission-mode', 'acceptEdits', '--input-format', 'text', '--output-format', 'stream-json', '--include-partial-messages', '--include-hook-events', '--verbose'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push('--debug-file', path.join(runtimeDir, 'claude-debug.log'));
    args.push(...buildAddDirArgs('--add-dir', uniqueAddDirs));
    return {
      stdinPrompt: true,
      command,
      args,
      env: baseEnv,
      parser: 'claude_stream_json',
      debugArtifactName: 'claude-debug',
      stdoutArtifactName: 'claude-stdout.raw',
      stderrArtifactName: 'claude-stderr.raw',
    };
  }

  // opencode
  const args = ['run', '--dir', cwd];
  if (model) args.push('--model', model);
  args.push('--format', 'default', prompt);
  return {
    command,
    args,
    env: {
      ...baseEnv,
      XDG_CACHE_HOME: opencodeCacheRoot,
      TMPDIR: runtimeDir,
    },
  };
}

module.exports = {
  discoverAgentCatalog,
  supportedAgents,
  buildAgentCommand,
};
