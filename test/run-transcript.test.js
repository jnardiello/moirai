const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranscriptParser, createClaudeStreamJsonParser, stripAnsi } = require('../lib/run-transcript');

test('stripAnsi removes terminal color sequences', () => {
  assert.equal(stripAnsi('\u001b[31mhello\u001b[0m'), 'hello');
});

test('parser emits note, action, and status events', () => {
  const events = [];
  const parser = createTranscriptParser((event) => events.push(event));

  parser.processChunk('MOIRAI_UI_NOTE: planning now\nMOIRAI_UI_ACTION: reading files\nMOIRAI_AGENT_PLAN_STATUS: ready\nMOIRAI_PLAN_STATUS: ready\nMOIRAI_VALIDATE_STATUS: pass\nMOIRAI_DOCS_STATUS: updated\n');
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_note', message: 'planning now' },
    { type: 'agent_action', message: 'reading files' },
    { type: 'agent_status', marker: 'MOIRAI_AGENT_PLAN_STATUS', value: 'ready' },
    { type: 'agent_status', marker: 'MOIRAI_PLAN_STATUS', value: 'ready' },
    { type: 'agent_status', marker: 'MOIRAI_VALIDATE_STATUS', value: 'pass' },
    { type: 'agent_status', marker: 'MOIRAI_DOCS_STATUS', value: 'updated' },
  ]);
});

test('parser emits structured input requests from JSON blocks', () => {
  const events = [];
  const parser = createTranscriptParser((event) => events.push(event));

  parser.processChunk([
    'codex',
    'MOIRAI_UI_REQUEST_INPUT_BEGIN',
    '{"request_id":"req-1","kind":"choice","prompt":"Pick one","choices":["yes","no"]}',
    'MOIRAI_UI_REQUEST_INPUT_END',
    '',
  ].join('\n'));
  parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'input_request');
  assert.deepEqual(events[0].request, {
    requestId: 'req-1',
    kind: 'choice',
    prompt: 'Pick one',
    choices: ['yes', 'no'],
  });
});

test('parser ignores codex preamble and starts at real agent markers', () => {
  const events = [];
  const parser = createTranscriptParser((event) => events.push(event));

  parser.processChunk([
    'OpenAI Codex v0.118.0 (research preview)',
    '--------',
    'user',
    'MOIRAI_UI_REQUEST_INPUT_BEGIN',
    '{"request_id":"<id>","kind":"text|confirm|choice","prompt":"<question>"}',
    'MOIRAI_UI_REQUEST_INPUT_END',
    'codex',
    'MOIRAI_UI_NOTE: actual note',
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_note', message: 'actual note' },
  ]);
});

test('parser collapses exec blocks into command and result events', () => {
  const events = [];
  const parser = createTranscriptParser((event) => events.push(event));

  parser.processChunk([
    'codex',
    'MOIRAI_UI_ACTION: reading files',
    'exec',
    '/bin/zsh -lc "sed -n \'1,20p\' README.md"',
    'succeeded in 0ms:',
    '# title',
    'codex',
    'MOIRAI_PLAN_STATUS: ready',
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_action', message: 'reading files' },
    { type: 'command', message: '/bin/zsh -lc "sed -n \'1,20p\' README.md"' },
    { type: 'success', message: 'succeeded in 0ms:' },
    { type: 'agent_status', marker: 'MOIRAI_PLAN_STATUS', value: 'ready' },
  ]);
});

test('parser ignores artifact blocks for plan and validation content', () => {
  const events = [];
  const parser = createTranscriptParser((event) => events.push(event));

  parser.processChunk([
    'codex',
    'MOIRAI_UI_NOTE: planning',
    'MOIRAI_PLAN_FILE_BEGIN',
    '# Planned Content',
    '- [ ] one',
    'MOIRAI_PLAN_FILE_END',
    'MOIRAI_AGENT_PLAN_BEGIN',
    '- [ ] Agent step',
    'MOIRAI_AGENT_PLAN_END',
    'MOIRAI_VALIDATE_SUMMARY_BEGIN',
    'Everything passed',
    'MOIRAI_VALIDATE_SUMMARY_END',
    'MOIRAI_MANUAL_TEST_BEGIN',
    'Click save',
    'MOIRAI_MANUAL_TEST_END',
    'MOIRAI_VALIDATE_STATUS: pass',
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_note', message: 'planning' },
    { type: 'agent_status', marker: 'MOIRAI_VALIDATE_STATUS', value: 'pass' },
  ]);
});

test('claude stream-json parser emits note and status from assistant text blocks', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [
          { type: 'text', text: 'MOIRAI_UI_NOTE: implementing now\nMOIRAI_IMPLEMENTATION_STATUS: complete' },
        ],
      },
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_note', message: 'implementing now' },
    { type: 'agent_status', marker: 'MOIRAI_IMPLEMENTATION_STATUS', value: 'complete' },
  ]);
});

test('claude stream-json parser emits action and command from tool use blocks', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-2',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status --short' } },
        ],
      },
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_action', message: 'Using Bash' },
    { type: 'command', message: 'git status --short' },
  ]);
});

test('claude stream-json parser emits visible system init events', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-6-v1',
      permissionMode: 'default',
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'system', message: 'Claude session initialized (claude-opus-4-6-v1 · default)' },
  ]);
});

test('claude stream-json parser emits lifecycle events for generic records', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'hook',
      subtype: 'pre_tool',
      hook_event_name: 'Bash',
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_action', message: 'hook: Bash · pre_tool' },
  ]);
});

test('claude stream-json parser emits fallback note for assistant text without MOIRAI markers', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-3',
        content: [
          { type: 'text', text: 'Implementing the landing page refresh now.' },
        ],
      },
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'agent_note', message: 'Implementing the landing page refresh now.' },
  ]);
});

test('claude stream-json parser emits fallback system event for successful textual result', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Finished cleanly',
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'system', message: 'Claude result: Finished cleanly' },
  ]);
});

test('claude stream-json parser emits error for failed tool results', () => {
  const events = [];
  const parser = createClaudeStreamJsonParser((event) => events.push(event));

  parser.processChunk([
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: 'Claude requested permissions to read from /tmp/example.md, but you have not granted it yet.',
          },
        ],
      },
    }),
    '',
  ].join('\n'));
  parser.flush();

  assert.deepEqual(events, [
    { type: 'error', message: 'Claude requested permissions to read from /tmp/example.md, but you have not granted it yet.' },
  ]);
});
