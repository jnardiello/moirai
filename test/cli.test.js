const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { parseCliArgs, formatDoctor } = require('../lib/cli');

test('parseCliArgs supports default start command and common flags', () => {
  const parsed = parseCliArgs(['--root', '.', '--port', '4555', '--host', '0.0.0.0', '--no-open', '--no-update-check']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.root, process.cwd());
  assert.equal(parsed.port, 4555);
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.open, false);
  assert.equal(parsed.updateCheck, false);
});

test('parseCliArgs supports doctor command', () => {
  const parsed = parseCliArgs(['doctor', '--root=..']);
  assert.equal(parsed.command, 'doctor');
  assert.equal(parsed.root, path.resolve('..'));
});

test('formatDoctor puts issues before warnings', () => {
  const text = formatDoctor({
    ok: false,
    issues: ['missing config'],
    warnings: ['missing codex'],
    detection: {
      projectRoot: '/tmp/example',
      hasConfig: false,
      structure: { status: 'fresh' },
    },
  });

  assert.match(text, /Moirai doctor: issues found/);
  assert.match(text, /Issues:\n- missing config/);
  assert.match(text, /Warnings:\n- missing codex/);
});
