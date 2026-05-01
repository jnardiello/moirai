const PHASE_KEYS = ['planning', 'implementing', 'validate'];

function normalizeField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePhaseSelection(selection = {}, fallback = {}) {
  return {
    agentId: normalizeField(selection.agentId ?? fallback.agentId),
    model: normalizeField(selection.model ?? fallback.model),
    effort: normalizeField(selection.effort ?? fallback.effort),
  };
}

function normalizePhaseConfig(storedPhaseConfig = {}, legacy = {}) {
  const source = storedPhaseConfig || {};
  const fallback = normalizePhaseSelection({
    agentId: legacy.assignedAgent,
    model: legacy.model,
    effort: legacy.effort,
  });

  return {
    planning: normalizePhaseSelection(source.planning, fallback),
    implementing: normalizePhaseSelection(source.implementing, fallback),
    validate: normalizePhaseSelection(source.validate, fallback),
  };
}

function getPhaseSelection(phaseConfig, phase) {
  return normalizePhaseConfig(phaseConfig)[phase] || normalizePhaseSelection();
}

module.exports = {
  PHASE_KEYS,
  normalizePhaseConfig,
  normalizePhaseSelection,
  getPhaseSelection,
};
