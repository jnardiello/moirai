const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveVersion } = require('../scripts/resolve-version');

test('resolveVersion supports npm version bump aliases', () => {
  assert.equal(resolveVersion('0.1.1', 'patch'), '0.1.2');
  assert.equal(resolveVersion('0.1.1', 'minor'), '0.2.0');
  assert.equal(resolveVersion('0.1.1', 'major'), '1.0.0');
});

test('resolveVersion accepts exact semver versions', () => {
  assert.equal(resolveVersion('0.1.1', '0.3.0'), '0.3.0');
});

test('resolveVersion rejects unsupported version requests', () => {
  assert.throws(() => resolveVersion('0.1.1', 'latest'), /Unsupported VERSION value/);
});
