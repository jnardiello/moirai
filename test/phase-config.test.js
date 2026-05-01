const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhaseConfig, getPhaseSelection } = require('../lib/phase-config');

test('normalizePhaseConfig migrates legacy flat selection into every phase', () => {
  const phaseConfig = normalizePhaseConfig(null, {
    assignedAgent: 'codex',
    model: 'gpt-5.4-mini',
    effort: 'medium',
  });

  assert.deepEqual(phaseConfig, {
    planning: { agentId: 'codex', model: 'gpt-5.4-mini', effort: 'medium' },
    implementing: { agentId: 'codex', model: 'gpt-5.4-mini', effort: 'medium' },
    validate: { agentId: 'codex', model: 'gpt-5.4-mini', effort: 'medium' },
  });
});

test('getPhaseSelection returns explicit per-phase values without leaking other phases', () => {
  const phaseConfig = normalizePhaseConfig({
    planning: { agentId: 'codex', model: 'gpt-5.4', effort: 'high' },
    implementing: { agentId: 'claude', model: 'sonnet', effort: 'medium' },
    validate: { agentId: 'opencode', model: 'opencode/big-pickle', effort: null },
  });

  assert.deepEqual(getPhaseSelection(phaseConfig, 'planning'), {
    agentId: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
  });
  assert.deepEqual(getPhaseSelection(phaseConfig, 'implementing'), {
    agentId: 'claude',
    model: 'sonnet',
    effort: 'medium',
  });
  assert.deepEqual(getPhaseSelection(phaseConfig, 'validate'), {
    agentId: 'opencode',
    model: 'opencode/big-pickle',
    effort: null,
  });
});
