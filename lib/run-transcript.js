const ANSI_PATTERN = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const SPEAKER_MARKERS = new Set(['assistant', 'codex', 'claude', 'opencode']);
const MOIRAI_MARKER_PATTERN = /MOIRAI_(?:UI_(?:NOTE|ACTION|SECTION|REQUEST_INPUT_BEGIN)|AGENT_PLAN_STATUS|PLAN_STATUS|IMPLEMENTATION_STATUS|VALIDATE_STATUS|DOCS_STATUS)/;
const NOISE_PATTERNS = [
  /^OpenAI Codex v/i,
  /^--------$/,
  /^workdir:/i,
  /^model:/i,
  /^provider:/i,
  /^approval:/i,
  /^sandbox:/i,
  /^reasoning effort:/i,
  /^reasoning summaries:/i,
  /^session id:/i,
];

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, '');
}

function parseInputRequestBlock(inputLines) {
  const rawPayload = inputLines.join('\n').trim();
  if (!rawPayload) {
    throw new Error('missing request payload');
  }

  const parsed = JSON.parse(rawPayload);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('input request payload must be an object');
  }
  if (typeof parsed.request_id !== 'string' || !parsed.request_id.trim()) {
    throw new Error('input request payload missing request_id');
  }
  if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
    throw new Error('input request payload missing prompt');
  }
  if (!['confirm', 'choice', 'text'].includes(parsed.kind)) {
    throw new Error('input request payload has invalid kind');
  }

  const request = {
    requestId: parsed.request_id.trim(),
    prompt: parsed.prompt.trim(),
    kind: parsed.kind,
    choices: Array.isArray(parsed.choices)
      ? parsed.choices.filter((choice) => typeof choice === 'string' && choice.trim())
      : [],
  };

  return request;
}

function parseOutputLine(line, stream, state) {
  const cleanLine = stripAnsi(line).trimEnd();
  const trimmed = cleanLine.trim();
  const events = [];

  if (state.capturingArtifactBlock) {
    if (trimmed === state.artifactEndMarker) {
      state.capturingArtifactBlock = false;
      state.artifactEndMarker = null;
    }
    return events;
  }

  if (state.ignoringExampleInputBlock) {
    if (trimmed === 'MOIRAI_UI_REQUEST_INPUT_END') {
      state.ignoringExampleInputBlock = false;
    }
    return events;
  }

  if (state.capturingInputBlock) {
    if (trimmed === 'MOIRAI_UI_REQUEST_INPUT_END') {
      try {
        const request = parseInputRequestBlock(state.inputLines);
        events.push({ type: 'input_request', request });
      } catch (error) {
        events.push({
          type: 'parser_error',
          message: error.message,
          raw: state.inputLines.join('\n'),
        });
      }
      state.capturingInputBlock = false;
      state.inputLines = [];
      return events;
    }

    state.inputLines.push(cleanLine);
    return events;
  }

  if (!trimmed) {
    return events;
  }

  if (trimmed === 'MOIRAI_PLAN_FILE_BEGIN') {
    state.capturingArtifactBlock = true;
    state.artifactEndMarker = 'MOIRAI_PLAN_FILE_END';
    return events;
  }

  if (trimmed === 'MOIRAI_AGENT_PLAN_BEGIN') {
    state.capturingArtifactBlock = true;
    state.artifactEndMarker = 'MOIRAI_AGENT_PLAN_END';
    return events;
  }

  if (trimmed === 'MOIRAI_VALIDATE_SUMMARY_BEGIN') {
    state.capturingArtifactBlock = true;
    state.artifactEndMarker = 'MOIRAI_VALIDATE_SUMMARY_END';
    return events;
  }

  if (trimmed === 'MOIRAI_MANUAL_TEST_BEGIN') {
    state.capturingArtifactBlock = true;
    state.artifactEndMarker = 'MOIRAI_MANUAL_TEST_END';
    return events;
  }

  if (state.pendingExecCommand) {
    state.pendingExecCommand = false;
    state.skippingExecOutput = true;
    events.push({
      type: 'command',
      message: cleanLine,
    });
    return events;
  }

  if (state.skippingExecOutput) {
    if (trimmed === 'exec') {
      state.skippingExecOutput = false;
      state.pendingExecCommand = true;
      return events;
    }

    if (SPEAKER_MARKERS.has(trimmed)) {
      state.skippingExecOutput = false;
      state.transcriptStarted = true;
      return events;
    }

    if (/^succeeded in .*:$/i.test(trimmed)) {
      events.push({
        type: 'success',
        message: trimmed,
      });
      return events;
    }

    if (/^failed in .*:$/i.test(trimmed)) {
      events.push({
        type: 'error',
        message: trimmed,
      });
      return events;
    }

    if (trimmed.startsWith('MOIRAI_UI_') || trimmed.startsWith('MOIRAI_')) {
      state.skippingExecOutput = false;
    } else {
      return events;
    }
  }

  if (!state.transcriptStarted) {
    if (trimmed === 'MOIRAI_UI_REQUEST_INPUT_BEGIN') {
      state.ignoringExampleInputBlock = true;
      return events;
    }

    if (trimmed === 'user') {
      return events;
    }

    if (trimmed === 'exec') {
      state.transcriptStarted = true;
      state.pendingExecCommand = true;
      return events;
    }

    if (SPEAKER_MARKERS.has(trimmed)) {
      state.transcriptStarted = true;
      return events;
    }

    if (trimmed.startsWith('MOIRAI_UI_') || trimmed.startsWith('MOIRAI_')) {
      state.transcriptStarted = true;
    } else {
      return events;
    }
  }

  if (trimmed === 'user') {
    return events;
  }

  if (trimmed === 'exec') {
    state.pendingExecCommand = true;
    return events;
  }

  if (SPEAKER_MARKERS.has(trimmed)) {
    return events;
  }

  if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return events;
  }

  if (/^[→•]\s+/.test(trimmed)) {
    events.push({
      type: 'agent_action',
      message: trimmed.replace(/^[→•]\s+/, ''),
    });
    return events;
  }

  if (trimmed === 'MOIRAI_UI_REQUEST_INPUT_BEGIN') {
    state.capturingInputBlock = true;
    state.inputLines = [];
    return events;
  }

  if (trimmed.startsWith('MOIRAI_UI_NOTE:')) {
    events.push({
      type: 'agent_note',
      message: trimmed.slice('MOIRAI_UI_NOTE:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_UI_ACTION:')) {
    events.push({
      type: 'agent_action',
      message: trimmed.slice('MOIRAI_UI_ACTION:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_UI_SECTION:')) {
    events.push({
      type: 'agent_section',
      section: trimmed.slice('MOIRAI_UI_SECTION:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_PLAN_STATUS:')) {
    events.push({
      type: 'agent_status',
      marker: 'MOIRAI_PLAN_STATUS',
      value: trimmed.slice('MOIRAI_PLAN_STATUS:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_AGENT_PLAN_STATUS:')) {
    events.push({
      type: 'agent_status',
      marker: 'MOIRAI_AGENT_PLAN_STATUS',
      value: trimmed.slice('MOIRAI_AGENT_PLAN_STATUS:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_IMPLEMENTATION_STATUS:')) {
    events.push({
      type: 'agent_status',
      marker: 'MOIRAI_IMPLEMENTATION_STATUS',
      value: trimmed.slice('MOIRAI_IMPLEMENTATION_STATUS:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_VALIDATE_STATUS:')) {
    events.push({
      type: 'agent_status',
      marker: 'MOIRAI_VALIDATE_STATUS',
      value: trimmed.slice('MOIRAI_VALIDATE_STATUS:'.length).trim(),
    });
    return events;
  }

  if (trimmed.startsWith('MOIRAI_DOCS_STATUS:')) {
    events.push({
      type: 'agent_status',
      marker: 'MOIRAI_DOCS_STATUS',
      value: trimmed.slice('MOIRAI_DOCS_STATUS:'.length).trim(),
    });
    return events;
  }

  events.push({
    type: stream === 'stderr' ? 'agent_error_output' : 'agent_output',
    message: cleanLine,
    stream,
  });

  return events;
}

function createTranscriptParser(onEvent) {
  const state = {
    buffer: '',
    capturingInputBlock: false,
    inputLines: [],
    ignoringExampleInputBlock: false,
    capturingArtifactBlock: false,
    artifactEndMarker: null,
    transcriptStarted: false,
    pendingExecCommand: false,
    skippingExecOutput: false,
  };

  function processChunk(chunk, stream = 'stdout') {
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    state.buffer += normalized;

    const parts = state.buffer.split('\n');
    state.buffer = parts.pop() || '';

    for (const line of parts) {
      const events = parseOutputLine(line, stream, state);
      for (const event of events) {
        onEvent(event);
      }
    }
  }

  function flush(stream = 'stdout') {
    if (state.buffer) {
      const events = parseOutputLine(state.buffer, stream, state);
      state.buffer = '';
      for (const event of events) {
        onEvent(event);
      }
    }

    if (state.capturingInputBlock) {
      onEvent({
        type: 'parser_error',
        message: 'input request block was not terminated',
        raw: state.inputLines.join('\n'),
      });
      state.capturingInputBlock = false;
      state.inputLines = [];
    }
  }

  return {
    processChunk,
    flush,
  };
}

function createClaudeStreamJsonParser(onEvent) {
  let emittedCount = 0;
  const emit = (event) => {
    emittedCount += 1;
    onEvent(event);
  };
  const textParser = createTranscriptParser(emit);
  const state = {
    buffer: '',
    seenToolUses: new Set(),
    seenLifecycleEvents: new Set(),
    fallbackTextByBlock: new Map(),
    textByBlock: new Map(),
  };

  function emitClaudeText(recordId, blockIndex, text) {
    if (typeof text !== 'string' || !text) {
      return;
    }

    const key = `${recordId}:${blockIndex}`;
    const previous = state.textByBlock.get(key) || '';
    if (previous === text) {
      return;
    }

    const delta = previous && text.startsWith(previous)
      ? text.slice(previous.length)
      : text;

    state.textByBlock.set(key, text);
    if (!delta) {
      return;
    }

    if (MOIRAI_MARKER_PATTERN.test(text) || MOIRAI_MARKER_PATTERN.test(delta)) {
      textParser.processChunk(`${delta}\n`, 'stdout');
      return;
    }

    const normalizedText = text.trim();
    if (!normalizedText) {
      return;
    }

    const previousFallback = state.fallbackTextByBlock.get(key) || '';
    const looksStable = /[\n.!?`]$/.test(normalizedText);
    if (looksStable && normalizedText !== previousFallback) {
      state.fallbackTextByBlock.set(key, normalizedText);
      emit({
        type: 'agent_note',
        message: normalizedText,
      });
    }
  }

  function emitClaudeToolUse(block, recordId, blockIndex) {
    const toolKey = block.id || `${recordId}:tool:${blockIndex}:${block.name || 'unknown'}`;
    if (state.seenToolUses.has(toolKey)) {
      return;
    }
    state.seenToolUses.add(toolKey);

    const toolName = typeof block.name === 'string' && block.name.trim()
      ? block.name.trim()
      : 'tool';
    emit({
      type: 'agent_action',
      message: `Using ${toolName}`,
    });

    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const command = typeof input.command === 'string' && input.command.trim()
      ? input.command.trim()
      : typeof input.cmd === 'string' && input.cmd.trim()
        ? input.cmd.trim()
        : '';

    if (command) {
      emit({
        type: 'command',
        message: command,
      });
    }
  }

  function emitClaudeLifecycle(kind, name, detail = '') {
    const normalizedKind = typeof kind === 'string' && kind.trim() ? kind.trim() : 'event';
    const normalizedName = typeof name === 'string' && name.trim() ? name.trim() : '';
    const normalizedDetail = typeof detail === 'string' && detail.trim() ? detail.trim() : '';
    const key = `${normalizedKind}:${normalizedName}:${normalizedDetail}`;
    if (state.seenLifecycleEvents.has(key)) {
      return;
    }
    state.seenLifecycleEvents.add(key);

    const parts = [];
    if (normalizedName) {
      parts.push(normalizedName);
    }
    if (normalizedDetail) {
      parts.push(normalizedDetail);
    }
    const message = parts.length > 0
      ? `${normalizedKind}: ${parts.join(' · ')}`
      : normalizedKind;

    emit({
      type: 'agent_action',
      message,
    });
  }

  function processRecord(record) {
    if (!record || typeof record !== 'object') {
      return;
    }

    const recordId = record.uuid || record.session_id || record.type || 'claude';

    if (record.type === 'assistant') {
      if (record.error) {
        emit({
          type: 'error',
          message: record.error,
        });
      }

      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      content.forEach((block, index) => {
        if (!block || typeof block !== 'object') {
          return;
        }
        if (block.type === 'text') {
          emitClaudeText(record.message?.id || recordId, index, block.text || '');
          return;
        }
        if (block.type === 'tool_use') {
          emitClaudeToolUse(block, record.message?.id || recordId, index);
        }
      });
      return;
    }

    if (record.type === 'result') {
      if (typeof record.result === 'string' && record.result.trim()) {
        const beforeCount = emittedCount;
        textParser.processChunk(`${record.result.trim()}\n`, 'stdout');
        if (record.is_error && !record.result.includes('MOIRAI_')) {
          emit({
            type: 'error',
            message: record.result.trim(),
          });
        }
        if (!record.is_error && emittedCount === beforeCount) {
          emit({
            type: 'system',
            message: `Claude result: ${record.result.trim()}`,
          });
        }
      }
      return;
    }

    if (record.type === 'user') {
      const toolResultBlocks = Array.isArray(record.message?.content) ? record.message.content : [];
      let emittedToolError = false;

      toolResultBlocks.forEach((block) => {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result' || !block.is_error) {
          return;
        }

        const detail = typeof block.content === 'string' && block.content.trim()
          ? block.content.trim()
          : typeof record.tool_use_result === 'string' && record.tool_use_result.trim()
            ? record.tool_use_result.trim()
            : '';

        emit({
          type: 'error',
          message: detail || 'Claude tool request failed',
        });
        emittedToolError = true;
      });

      if (emittedToolError) {
        return;
      }

      return;
    }

    if (record.type === 'stream_event') {
      return;
    }

    if (record.type === 'system' && record.subtype === 'init') {
      const details = [
        record.model || null,
        record.permissionMode || null,
      ].filter(Boolean).join(' · ');
      emit({
        type: 'system',
        message: details ? `Claude session initialized (${details})` : 'Claude session initialized',
      });
      return;
    }

    if (record.type === 'system') {
      const detail = typeof record.message === 'string'
        ? record.message
        : typeof record.error === 'string'
          ? record.error
          : '';
      emit({
        type: 'system',
        message: detail
          ? `Claude ${record.subtype || 'system'}: ${detail}`
          : `Claude ${record.subtype || 'system'} event`,
      });
      return;
    }

    if (Array.isArray(record.permission_denials) && record.permission_denials.length > 0) {
      emit({
        type: 'error',
        message: `Claude permission denied: ${record.permission_denials.join(', ')}`,
      });
    }

    if (record.type === 'rate_limit_event') {
      const info = record.rate_limit_info || {};
      const messageParts = [
        info.rateLimitType || null,
        info.status || null,
        info.overageStatus || null,
      ].filter(Boolean);
      emit({
        type: 'system',
        message: messageParts.length > 0
          ? `Claude rate limit: ${messageParts.join(' · ')}`
          : 'Claude rate limit update',
      });
      return;
    }

    const lifecycleName = record.name || record.tool_name || record.hook_event_name || record.event || '';
    const lifecycleDetail = record.subtype || record.type || '';
    const input = record.input && typeof record.input === 'object' ? record.input : {};
    const command = typeof input.command === 'string' && input.command.trim()
      ? input.command.trim()
      : typeof input.cmd === 'string' && input.cmd.trim()
        ? input.cmd.trim()
        : '';

    if (command) {
      emitClaudeLifecycle(record.type || 'tool', lifecycleName || 'command');
      emit({
        type: 'command',
        message: command,
      });
      return;
    }

    if (typeof record.message === 'string' && record.message.trim()) {
      const messageText = record.message.trim();
      if (MOIRAI_MARKER_PATTERN.test(messageText)) {
        textParser.processChunk(`${messageText}\n`, 'stdout');
      } else {
        emit({
          type: 'system',
          message: messageText,
        });
      }
      return;
    }

    if (lifecycleName || lifecycleDetail) {
      emitClaudeLifecycle(record.type || 'event', lifecycleName, lifecycleDetail);
    }
  }

  function processChunk(chunk) {
    const normalized = stripAnsi(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    state.buffer += normalized;

    const parts = state.buffer.split('\n');
    state.buffer = parts.pop() || '';

    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        processRecord(JSON.parse(trimmed));
      } catch {
        textParser.processChunk(`${line}\n`, 'stdout');
      }
    }
  }

  function flush() {
    if (state.buffer.trim()) {
      try {
        processRecord(JSON.parse(state.buffer.trim()));
      } catch {
        textParser.processChunk(`${state.buffer}\n`, 'stdout');
      }
      state.buffer = '';
    }

    textParser.flush('stdout');
  }

  return {
    processChunk,
    flush,
  };
}

module.exports = {
  createTranscriptParser,
  createClaudeStreamJsonParser,
  stripAnsi,
};
