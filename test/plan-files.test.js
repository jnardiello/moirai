const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendPlanFeedbackEntry,
  AGENT_PLAN_APPENDIX_BEGIN,
  AGENT_PLAN_APPENDIX_END,
  extractDelimitedBlock,
  getPrimaryPlanRef,
  markPlanExecuted,
  parsePlanFeedbackHistory,
  splitPlanFeedbackHistory,
  upsertAgentPlanAppendix,
  writePlanFile,
} = require('../lib/plan-files');

function makeBacklogRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-plan-files-'));
  fs.mkdirSync(path.join(root, 'plans', 'doing'), { recursive: true });
  return root;
}

test('extractDelimitedBlock returns block content between markers', () => {
  const text = [
    'prefix',
    'MOIRAI_PLAN_FILE_BEGIN',
    '# Title',
    '- [ ] one',
    'MOIRAI_PLAN_FILE_END',
    'suffix',
  ].join('\n');

  assert.equal(extractDelimitedBlock(text, 'MOIRAI_PLAN_FILE_BEGIN', 'MOIRAI_PLAN_FILE_END'), '# Title\n- [ ] one');
});

test('extractDelimitedBlock prefers the latest non-placeholder block', () => {
  const text = [
    'MOIRAI_PLAN_FILE_BEGIN',
    '<full markdown plan content>',
    'MOIRAI_PLAN_FILE_END',
    'middle',
    'MOIRAI_PLAN_FILE_BEGIN',
    '# Real Plan',
    '- [ ] actual work',
    'MOIRAI_PLAN_FILE_END',
  ].join('\n');

  assert.equal(extractDelimitedBlock(text, 'MOIRAI_PLAN_FILE_BEGIN', 'MOIRAI_PLAN_FILE_END'), '# Real Plan\n- [ ] actual work');
});

test('getPrimaryPlanRef returns the first linked plan file', () => {
  assert.equal(getPrimaryPlanRef({ plans_files: ['plans/doing/a.md', 'plans/doing/b.md'] }), 'plans/doing/a.md');
});

test('markPlanExecuted checks remaining boxes and appends validation section', () => {
  const root = makeBacklogRoot();
  const planRef = 'plans/doing/example.md';
  fs.writeFileSync(path.join(root, planRef), '');
  writePlanFile(root, planRef, [
    '# Example',
    '',
    '- [ ] first',
    '- [x] second',
    '',
    '## Notes',
    '',
    'Keep this.',
  ].join('\n'));

  const updated = markPlanExecuted(root, planRef, {
    completedAt: '2026-04-10T16:00:00Z',
    validateSummary: 'All backend automated tests passed.',
    manualTestInstructions: '1. Open the page.\n2. Save the form.',
  });

  assert.match(updated, /- \[x\] first/);
  assert.match(updated, /## Validation Completion/);
  assert.match(updated, /All backend automated tests passed\./);
  assert.match(updated, /1\. Open the page\./);
});

test('appendPlanFeedbackEntry preserves plan body and feedback history', () => {
  const first = appendPlanFeedbackEntry('# Plan\n\n- [ ] one', {
    timestamp: '2026-04-11T08:00:00.000Z',
    iteration: 1,
    kind: 'agent_generation',
    status: 'generated',
    runId: 'run-1',
    feedback: 'Make it safer.',
  });
  const second = appendPlanFeedbackEntry('# Plan v2\n\n- [ ] one\n- [ ] two\n\n' + splitPlanFeedbackHistory(first).history, {
    timestamp: '2026-04-11T09:00:00.000Z',
    iteration: 2,
    kind: 'human_approval',
    status: 'approved',
    feedback: 'Plan approved by human reviewer.',
  });

  assert.match(second, /^# Plan v2/);
  assert.match(second, /## Plan Feedback History/);
  assert.match(second, /Iteration 1 - 2026-04-11T08:00:00.000Z/);
  assert.match(second, /Make it safer\./);
  assert.match(second, /Iteration 2 - 2026-04-11T09:00:00.000Z/);
  assert.match(second, /approved/);

  assert.deepEqual(parsePlanFeedbackHistory(second), [
    {
      iteration: 1,
      timestamp: '2026-04-11T08:00:00.000Z',
      kind: 'agent_generation',
      status: 'generated',
      runId: 'run-1',
      feedback: 'Make it safer.',
    },
    {
      iteration: 2,
      timestamp: '2026-04-11T09:00:00.000Z',
      kind: 'human_approval',
      status: 'approved',
      runId: null,
      feedback: 'Plan approved by human reviewer.',
    },
  ]);
});

test('upsertAgentPlanAppendix adds appendix before feedback history', () => {
  const original = [
    '# Plan',
    '',
    'Approved human plan.',
    '',
    '## Plan Feedback History',
    '',
    '### Iteration 1 - 2026-04-11T08:00:00.000Z',
    '',
    '- Type: human_approval',
  ].join('\n');

  const updated = upsertAgentPlanAppendix(original, '- [ ] Implement the first step.', {
    generatedAt: '2026-04-12T10:00:00.000Z',
    runId: 'run-1',
  });

  assert.match(updated, /^# Plan\n\nApproved human plan\./);
  assert.match(updated, new RegExp(`${AGENT_PLAN_APPENDIX_BEGIN}[\\s\\S]*## Agent Plan[\\s\\S]*- Run: run-1[\\s\\S]*- \\[ \\] Implement the first step\\.[\\s\\S]*${AGENT_PLAN_APPENDIX_END}`));
  assert.ok(updated.indexOf(AGENT_PLAN_APPENDIX_BEGIN) < updated.indexOf('## Plan Feedback History'));
  assert.match(updated, /### Iteration 1 - 2026-04-11T08:00:00.000Z/);
});

test('upsertAgentPlanAppendix replaces only existing managed appendix', () => {
  const first = upsertAgentPlanAppendix('# Plan\n\nKeep me.', '- [ ] Old step.', {
    generatedAt: '2026-04-12T10:00:00.000Z',
    runId: 'run-old',
  });
  const second = upsertAgentPlanAppendix(first, '- [ ] New step.', {
    generatedAt: '2026-04-12T11:00:00.000Z',
    runId: 'run-new',
  });

  assert.match(second, /^# Plan\n\nKeep me\./);
  assert.doesNotMatch(second, /Old step/);
  assert.doesNotMatch(second, /run-old/);
  assert.match(second, /New step/);
  assert.match(second, /run-new/);
  assert.equal((second.match(new RegExp(AGENT_PLAN_APPENDIX_BEGIN, 'g')) || []).length, 1);
});
