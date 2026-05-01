const test = require('node:test');
const assert = require('node:assert/strict');

const { supportedAgents, buildAgentCommand } = require('../lib/agents');

test('supportedAgents exposes normalized supportsEffort metadata', () => {
  const agents = supportedAgents({
    agents: {
      codex: { command: 'codex', models: ['gpt-5.4'], efforts: ['medium', 'medium', 'high'] },
      claude: { command: 'claude', models: ['sonnet'], efforts: [] },
    },
  });

  const codex = agents.find((agent) => agent.id === 'codex');
  const claude = agents.find((agent) => agent.id === 'claude');

  assert.deepEqual(codex.models, ['gpt-5.4']);
  assert.deepEqual(codex.efforts, ['medium', 'high']);
  assert.equal(codex.supportsEffort, true);

  assert.deepEqual(claude.models, ['sonnet']);
  assert.deepEqual(claude.efforts, []);
  assert.equal(claude.supportsEffort, false);
});

test('buildAgentCommand configures Claude stream-json diagnostics', () => {
  const command = buildAgentCommand('claude', {
    agents: {
      claude: { command: 'claude' },
    },
  }, {
    cwd: '/tmp/worktree',
    prompt: 'hello',
    runtimeDir: '/tmp/run',
    model: 'sonnet',
    effort: 'max',
  });

  assert.equal(command.command, 'claude');
  assert.equal(command.parser, 'claude_stream_json');
  assert.equal(command.stdinPrompt, true);
  assert.equal(command.debugArtifactName, 'claude-debug');
  assert.equal(command.stdoutArtifactName, 'claude-stdout.raw');
  assert.equal(command.stderrArtifactName, 'claude-stderr.raw');
  assert.ok(command.args.includes('--input-format'));
  assert.ok(command.args.includes('text'));
  assert.ok(command.args.includes('--permission-mode'));
  assert.ok(command.args.includes('acceptEdits'));
  assert.ok(command.args.includes('--output-format'));
  assert.ok(command.args.includes('stream-json'));
  assert.ok(command.args.includes('--include-hook-events'));
  assert.ok(command.args.includes('--add-dir'));
  assert.ok(command.args.includes('/tmp/worktree'));
  assert.ok(command.args.includes('--debug-file'));
  assert.equal(command.args.includes('--bare'), false);
  assert.equal(command.args.includes('hello'), false);
});
