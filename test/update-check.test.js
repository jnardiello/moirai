const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  checkForUpdateAndMaybeInstall,
  checkForUpdateNotice,
  formatUpdateNotice,
  isGlobalInstall,
  isNewerVersion,
  packageMetadataUrl,
} = require('../lib/update-check');

test('isNewerVersion compares semver versions', () => {
  assert.equal(isNewerVersion('0.1.0', '0.1.1'), true);
  assert.equal(isNewerVersion('0.1.9', '0.2.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.2.0', '1.1.9'), false);
  assert.equal(isNewerVersion('invalid', '1.0.0'), false);
});

test('packageMetadataUrl points at the npm latest document', () => {
  assert.equal(
    packageMetadataUrl('@jnardiello/moirai', 'https://registry.npmjs.org/'),
    'https://registry.npmjs.org/@jnardiello%2Fmoirai/latest',
  );
});

test('isGlobalInstall detects packages under global node_modules', () => {
  const globalRoot = path.resolve('/tmp/node_modules');
  const packageRoot = path.join(globalRoot, '@jnardiello', 'moirai');
  assert.equal(isGlobalInstall(packageRoot, { globalRoot, env: {} }), true);
  assert.equal(isGlobalInstall('/tmp/project/moirai', { globalRoot, env: {} }), false);
});

test('checkForUpdateNotice skips disabled checks', async () => {
  const result = await checkForUpdateNotice({
    env: { MOIRAI_NO_UPDATE_CHECK: '1' },
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
  });
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'disabled');
});

test('checkForUpdateNotice writes an update suggestion for global installs', async () => {
  let output = '';
  const result = await checkForUpdateNotice({
    env: {},
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
    fetchLatestVersion: async () => '0.2.0',
    stderr: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.updateAvailable, true);
  assert.match(output, /Moirai update available: 0\.1\.0 -> 0\.2\.0/);
  assert.match(output, /npm install -g @jnardiello\/moirai@latest/);
});

test('formatUpdateNotice includes the global install command', () => {
  assert.equal(
    formatUpdateNotice('0.1.0', '0.1.1'),
    'Moirai update available: 0.1.0 -> 0.1.1\nRun: npm install -g @jnardiello/moirai@latest',
  );
});

test('checkForUpdateAndMaybeInstall installs and reruns after confirmation', async () => {
  let output = '';
  let installed = false;
  let reran = false;

  const result = await checkForUpdateAndMaybeInstall({
    env: {},
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
    fetchLatestVersion: async () => '0.2.0',
    confirmUpdate: async ({ latestVersion }) => latestVersion === '0.2.0',
    installLatestVersion: async ({ packageName }) => {
      installed = packageName === '@jnardiello/moirai';
      return { ok: true, status: 0 };
    },
    rerunCommand: async ({ env }) => {
      reran = env.MOIRAI_NO_UPDATE_CHECK === '1' && env.MOIRAI_UPDATED_THIS_RUN === '1';
      return { ok: true, status: 0 };
    },
    stderr: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.updated, true);
  assert.equal(result.rerun, true);
  assert.equal(result.exitCode, 0);
  assert.equal(installed, true);
  assert.equal(reran, true);
  assert.match(output, /Moirai update available: 0\.1\.0 -> 0\.2\.0/);
  assert.match(output, /Installing @jnardiello\/moirai@latest before starting Moirai/);
});

test('checkForUpdateAndMaybeInstall continues when the update is declined', async () => {
  let installCalled = false;
  let output = '';

  const result = await checkForUpdateAndMaybeInstall({
    env: {},
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
    fetchLatestVersion: async () => '0.2.0',
    confirmUpdate: async () => false,
    installLatestVersion: async () => {
      installCalled = true;
      return { ok: true, status: 0 };
    },
    stderr: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, 'declined');
  assert.equal(installCalled, false);
  assert.match(output, /Starting current Moirai version/);
});

test('checkForUpdateAndMaybeInstall skips auto-update without an interactive prompt', async () => {
  let installCalled = false;

  const result = await checkForUpdateAndMaybeInstall({
    env: {},
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
    fetchLatestVersion: async () => '0.2.0',
    stdin: { isTTY: false },
    installLatestVersion: async () => {
      installCalled = true;
      return { ok: true, status: 0 };
    },
    stderr: {
      write() {},
    },
  });

  assert.equal(result.updated, false);
  assert.equal(result.reason, 'not_interactive');
  assert.equal(installCalled, false);
});

test('checkForUpdateAndMaybeInstall aborts startup when install fails', async () => {
  const result = await checkForUpdateAndMaybeInstall({
    env: {},
    currentVersion: '0.1.0',
    packageRoot: '/tmp/node_modules/@jnardiello/moirai',
    globalRoot: '/tmp/node_modules',
    fetchLatestVersion: async () => '0.2.0',
    confirmUpdate: async () => true,
    installLatestVersion: async () => ({ ok: false, status: 7 }),
    rerunCommand: async () => {
      throw new Error('rerun should not be called');
    },
    stderr: {
      write() {},
    },
  });

  assert.equal(result.abort, true);
  assert.equal(result.exitCode, 7);
  assert.equal(result.reason, 'install_failed');
});
