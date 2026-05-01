const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_NAME = '@jnardiello/moirai';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_TIMEOUT_MS = 1500;

function normalizeRegistryUrl(registryUrl = DEFAULT_REGISTRY) {
  return registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`;
}

function packageMetadataUrl(packageName = PACKAGE_NAME, registryUrl = DEFAULT_REGISTRY) {
  const escapedName = packageName.replace('/', '%2F');
  return new URL(`${escapedName}/latest`, normalizeRegistryUrl(registryUrl)).toString();
}

function parseVersion(version) {
  if (typeof version !== 'string') {
    return null;
  }
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number(part));
}

function isNewerVersion(currentVersion, latestVersion) {
  const current = parseVersion(currentVersion);
  const latest = parseVersion(latestVersion);
  if (!current || !latest) {
    return false;
  }

  for (let index = 0; index < latest.length; index += 1) {
    if (latest[index] > current[index]) return true;
    if (latest[index] < current[index]) return false;
  }
  return false;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getGlobalNodeModules(command = 'npm') {
  const result = spawnSync(command, ['root', '-g'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
  if (result.status !== 0) {
    return null;
  }
  const globalRoot = (result.stdout || '').trim();
  return globalRoot || null;
}

function isGlobalInstall(packageRoot, options = {}) {
  const env = options.env || process.env;
  if (env.MOIRAI_FORCE_GLOBAL_INSTALL === '1') {
    return true;
  }
  if (env.MOIRAI_FORCE_GLOBAL_INSTALL === '0') {
    return false;
  }

  const globalRoot = options.globalRoot || getGlobalNodeModules(options.npmCommand || 'npm');
  if (!globalRoot) {
    return false;
  }

  const normalizedPackageRoot = path.resolve(packageRoot);
  const normalizedGlobalRoot = path.resolve(globalRoot);
  if (isPathInside(normalizedGlobalRoot, normalizedPackageRoot)) {
    return true;
  }

  return isPathInside(safeRealpath(normalizedGlobalRoot), safeRealpath(normalizedPackageRoot));
}

function fetchLatestVersion(options = {}) {
  const registryUrl = options.registryUrl || process.env.MOIRAI_NPM_REGISTRY || DEFAULT_REGISTRY;
  const packageName = options.packageName || PACKAGE_NAME;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = packageMetadataUrl(packageName, registryUrl);
  const client = options.client || https;

  return new Promise((resolve) => {
    const request = client.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': `moirai-update-check/${options.currentVersion || 'unknown'}`,
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }

      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(typeof parsed.version === 'string' ? parsed.version : null);
        } catch {
          resolve(null);
        }
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

function formatUpdateNotice(currentVersion, latestVersion, packageName = PACKAGE_NAME) {
  return [
    `Moirai update available: ${currentVersion} -> ${latestVersion}`,
    `Run: npm install -g ${packageName}@latest`,
  ].join('\n');
}

async function checkForUpdateNotice(options = {}) {
  const env = options.env || process.env;
  if (env.MOIRAI_NO_UPDATE_CHECK === '1' || env.CI === '1') {
    return { checked: false, reason: 'disabled' };
  }

  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  if (!isGlobalInstall(packageRoot, options)) {
    return { checked: false, reason: 'not_global' };
  }

  const currentVersion = options.currentVersion;
  const latestVersion = await (options.fetchLatestVersion || fetchLatestVersion)({
    ...options,
    currentVersion,
  });

  if (!latestVersion) {
    return { checked: true, updateAvailable: false, latestVersion: null };
  }

  const updateAvailable = isNewerVersion(currentVersion, latestVersion);
  if (updateAvailable && options.stderr) {
    options.stderr.write(`\n${formatUpdateNotice(currentVersion, latestVersion, options.packageName)}\n\n`);
  }

  return {
    checked: true,
    updateAvailable,
    currentVersion,
    latestVersion,
  };
}

module.exports = {
  DEFAULT_REGISTRY,
  DEFAULT_TIMEOUT_MS,
  PACKAGE_NAME,
  checkForUpdateNotice,
  fetchLatestVersion,
  formatUpdateNotice,
  getGlobalNodeModules,
  isGlobalInstall,
  isNewerVersion,
  packageMetadataUrl,
};
