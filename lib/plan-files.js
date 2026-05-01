const fs = require('fs');
const path = require('path');

const PLAN_FEEDBACK_HEADING = '## Plan Feedback History';
const AGENT_PLAN_APPENDIX_BEGIN = '<!-- MOIRAI_AGENT_PLAN_APPENDIX_BEGIN -->';
const AGENT_PLAN_APPENDIX_END = '<!-- MOIRAI_AGENT_PLAN_APPENDIX_END -->';

function resolvePlanPath(backlogRoot, planRef) {
  const resolved = path.resolve(backlogRoot, planRef);
  if (!resolved.startsWith(backlogRoot + path.sep)) {
    throw new Error('forbidden plan path');
  }
  return resolved;
}

function getPrimaryPlanRef(task) {
  const planRef = Array.isArray(task.plans_files) ? task.plans_files[0] : null;
  if (!planRef) {
    throw new Error('task has no linked plan file');
  }
  return planRef;
}

function readPlanFile(backlogRoot, planRef) {
  const resolved = resolvePlanPath(backlogRoot, planRef);
  if (!fs.existsSync(resolved)) {
    throw new Error('plan file not found');
  }
  return fs.readFileSync(resolved, 'utf-8');
}

function writePlanFile(backlogRoot, planRef, content) {
  const resolved = resolvePlanPath(backlogRoot, planRef);
  if (!fs.existsSync(resolved)) {
    throw new Error('plan file not found');
  }
  fs.writeFileSync(resolved, normalizeMarkdown(content), 'utf-8');
  return resolved;
}

function normalizeMarkdown(content) {
  const trimmed = (content || '').trim();
  return trimmed ? `${trimmed}\n` : '';
}

function splitPlanFeedbackHistory(content) {
  const normalized = content || '';
  const marker = `\n${PLAN_FEEDBACK_HEADING}\n`;
  const index = normalized.indexOf(marker);
  if (index === -1) {
    const startsWithMarker = normalized.startsWith(`${PLAN_FEEDBACK_HEADING}\n`);
    if (!startsWithMarker) {
      return {
        body: normalized.trimEnd(),
        history: '',
      };
    }
    return {
      body: '',
      history: normalized.trim(),
    };
  }

  return {
    body: normalized.slice(0, index).trimEnd(),
    history: normalized.slice(index + 1).trim(),
  };
}

function appendPlanFeedbackEntry(content, entry) {
  const {
    timestamp,
    iteration,
    kind = 'feedback',
    status = 'generated',
    runId = null,
    feedback = '',
  } = entry || {};
  const split = splitPlanFeedbackHistory(content);
  const existingHistoryBody = split.history
    ? split.history.replace(new RegExp(`^${PLAN_FEEDBACK_HEADING}\\n?`), '').trim()
    : '';
  const lines = [
    `### Iteration ${iteration || 1} - ${timestamp || new Date().toISOString()}`,
    '',
    `- Type: ${kind}`,
    `- Status: ${status}`,
    runId ? `- Run: ${runId}` : null,
    '- User input:',
    '',
    ...String(feedback || 'None.').split('\n').map((line) => `> ${line}`),
  ].filter((line) => line !== null);
  const nextHistory = [
    PLAN_FEEDBACK_HEADING,
    existingHistoryBody,
    lines.join('\n'),
  ].filter(Boolean).join('\n\n');

  return normalizeMarkdown(`${split.body}\n\n${nextHistory}`);
}

function buildAgentPlanAppendix(agentPlan, options = {}) {
  const {
    generatedAt = new Date().toISOString(),
    runId = null,
  } = options;
  const lines = [
    AGENT_PLAN_APPENDIX_BEGIN,
    '## Agent Plan',
    '',
    `- Generated at: ${generatedAt}`,
    runId ? `- Run: ${runId}` : null,
    '',
    String(agentPlan || '').trim(),
    AGENT_PLAN_APPENDIX_END,
  ].filter((line) => line !== null);

  return lines.join('\n');
}

function upsertAgentPlanAppendix(content, agentPlan, options = {}) {
  const normalized = content || '';
  const appendix = buildAgentPlanAppendix(agentPlan, options);
  const beginIndex = normalized.indexOf(AGENT_PLAN_APPENDIX_BEGIN);
  const endIndex = normalized.indexOf(AGENT_PLAN_APPENDIX_END);

  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    const before = normalized.slice(0, beginIndex).trimEnd();
    const after = normalized.slice(endIndex + AGENT_PLAN_APPENDIX_END.length).trimStart();
    return normalizeMarkdown([before, appendix, after].filter(Boolean).join('\n\n'));
  }

  const split = splitPlanFeedbackHistory(normalized);
  const bodyWithAppendix = [split.body, appendix].filter(Boolean).join('\n\n');
  return normalizeMarkdown([bodyWithAppendix, split.history].filter(Boolean).join('\n\n'));
}

function parsePlanFeedbackHistory(content) {
  const split = splitPlanFeedbackHistory(content);
  const history = split.history
    ? split.history.replace(new RegExp(`^${PLAN_FEEDBACK_HEADING}\\n?`), '').trim()
    : '';
  if (!history) {
    return [];
  }

  return history
    .split(/\n(?=### Iteration\s+)/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const headingMatch = entry.match(/^### Iteration\s+(\d+)\s+-\s+(.+)$/m);
      const fieldValue = (label) => {
        const match = entry.match(new RegExp(`^- ${label}:\\s*(.+)$`, 'm'));
        return match ? match[1].trim() : null;
      };
      const feedbackMatch = entry.match(/- User input:\n\n([\s\S]*)$/);
      const feedback = feedbackMatch
        ? feedbackMatch[1].split('\n').map((line) => line.replace(/^>\s?/, '')).join('\n').trim()
        : '';
      return {
        iteration: headingMatch ? Number(headingMatch[1]) : null,
        timestamp: headingMatch ? headingMatch[2].trim() : null,
        kind: fieldValue('Type'),
        status: fieldValue('Status'),
        runId: fieldValue('Run'),
        feedback,
      };
    });
}

function replaceUncheckedBoxes(content) {
  return content.replace(/^- \[ \]/gm, '- [x]');
}

function stripExistingValidationSection(content) {
  const marker = '\n## Validation Completion\n';
  const index = content.indexOf(marker);
  if (index === -1) {
    return content;
  }
  return content.slice(0, index).trimEnd();
}

function markPlanExecuted(backlogRoot, planRef, options) {
  const {
    completedAt,
    validateSummary,
    manualTestInstructions,
  } = options;

  const original = readPlanFile(backlogRoot, planRef);
  const checked = replaceUncheckedBoxes(original);
  const withoutValidationSection = stripExistingValidationSection(checked);
  const completionSection = [
    '## Validation Completion',
    '',
    `- Completed at: ${completedAt}`,
    '- Backend automated tests were executed in the Validate phase.',
    '- Documentation was updated as part of the implementation patch.',
    '',
    '### Validate Summary',
    '',
    (validateSummary || 'Validate phase completed successfully.').trim(),
    '',
    '### Manual Test Instructions',
    '',
    (manualTestInstructions || 'No manual test instructions were provided.').trim(),
    '',
  ].join('\n');

  const updated = normalizeMarkdown(`${withoutValidationSection}\n\n${completionSection}`);
  writePlanFile(backlogRoot, planRef, updated);
  return updated;
}

function extractDelimitedBlock(text, beginMarker, endMarker) {
  const placeholderValues = new Set([
    '<full markdown plan content>',
    '<markdown summary>',
    '<markdown instructions>',
    '<structured agent todo list>',
  ]);

  let searchIndex = 0;
  let latestValid = null;

  while (true) {
    const startIndex = text.indexOf(beginMarker, searchIndex);
    if (startIndex === -1) {
      break;
    }
    const contentStart = startIndex + beginMarker.length;
    const endIndex = text.indexOf(endMarker, contentStart);
    if (endIndex === -1) {
      break;
    }

    const candidate = text.slice(contentStart, endIndex).trim();
    if (candidate && !placeholderValues.has(candidate)) {
      latestValid = candidate;
    }

    searchIndex = endIndex + endMarker.length;
  }

  return latestValid;
}

module.exports = {
  AGENT_PLAN_APPENDIX_BEGIN,
  AGENT_PLAN_APPENDIX_END,
  extractDelimitedBlock,
  appendPlanFeedbackEntry,
  upsertAgentPlanAppendix,
  getPrimaryPlanRef,
  markPlanExecuted,
  normalizeMarkdown,
  parsePlanFeedbackHistory,
  readPlanFile,
  resolvePlanPath,
  splitPlanFeedbackHistory,
  writePlanFile,
};
