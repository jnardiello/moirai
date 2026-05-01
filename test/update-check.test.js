const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
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
