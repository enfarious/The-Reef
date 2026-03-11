// ─── Tool execution — IPC dispatch, colony_ask, custom tools ─────────────────

import { PERSONAS, state } from './state.js';
import { SKILL_MAP } from './tools.js';
import { appendTransmissionMsg, appendAssistantMsg, setThinking } from './messages-ui.js';
import { thinkingTimers } from './abort.js';
import { scheduleTask, cancelTask, listTasks } from './scheduler.js';

const COLONY_ASK_TIMEOUT_MS = 90_000;  // 90s — must be shorter than maxThinkingTime

// Injected callback — callPersonaOnce lives in the orchestrator
let _callPersonaOnce;
export function setToolExecCallbacks({ callPersonaOnce }) {
  _callPersonaOnce = callPersonaOnce;
}

export async function executeTool(callerPersonaId, toolCall) {
  const { name, input } = toolCall;

  // colony_ask is handled renderer-side — runs a live completion
  if (name === 'colony_ask') {
    return executeColonyAsk(callerPersonaId, input);
  }

  // Scheduled tasks — renderer-side (needs setTimeout + conversation access)
  if (name === 'schedule_task')   return scheduleTask(callerPersonaId, input);
  if (name === 'schedule_list')   return listTasks();
  if (name === 'schedule_cancel') return cancelTask(input.id);

  // Custom imported tools — call their HTTP endpoint
  const customTool = (state.config.settings.customTools || []).find(t => t.name === name);
  if (customTool) {
    if (!customTool.endpoint) throw new Error(`Custom tool "${name}" has no endpoint. Re-import with an "endpoint" field.`);
    try {
      const resp = await fetch(customTool.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const data = await resp.json();
      return JSON.stringify(data);
    } catch (err) {
      throw new Error(`Custom tool "${name}": ${err.message}`);
    }
  }

  const skillName = SKILL_MAP[name];
  if (!skillName) throw new Error(`Unknown tool: ${name}`);

  // Inject contextual defaults the model shouldn't need to know explicitly
  let invokeArgs = input;
  if (skillName.startsWith('reef.')) {
    const s = state.config.settings;
    const entityReefKey = state.config[callerPersonaId]?.reefApiKey;
    invokeArgs = {
      ...input,
      baseUrl: s.reefUrl    || undefined,
      apiKey:  input.apiKey || entityReefKey || s.reefApiKey || undefined,
    };
  } else if (skillName === 'web.search' && !input.apiKey) {
    const tavilyKey = state.config.settings.tavilyApiKey || '';
    if (tavilyKey) invokeArgs = { ...input, apiKey: tavilyKey };
  } else if (skillName === 'project.scan' && state.cwd && !input.path) {
    invokeArgs = { ...input, path: state.cwd };
  } else if ((skillName === 'shell.run' || skillName === 'code.search' || skillName.startsWith('git.'))
             && state.cwd && !input.cwd) {
    invokeArgs = { ...input, cwd: state.cwd };
  }

  const result = await window.reef.invoke(skillName, invokeArgs);
  if (!result.ok) throw new Error(result.error);

  // Vision tools return structured image data — pass through for special handling
  if (result.result?.__vision) return result.result;

  return typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result, null, 2);
}

// ─── colony.ask — inter-persona transmission ─────────────────────────────────

async function executeColonyAsk(callerPersonaId, { to, message }) {
  const targetPersona = PERSONAS.find(p => {
    const n = state.config[p.id].name || p.name;
    return n.toLowerCase() === to.toLowerCase();
  });
  if (!targetPersona) throw new Error(`Unknown colony member: "${to}"`);
  const targetId     = targetPersona.id;
  const callerPersona = PERSONAS.find(p => p.id === callerPersonaId);
  const callerName    = state.config[callerPersonaId].name || callerPersona.name;

  if (state.thinking[targetId]) {
    throw new Error(`${targetPersona.name} is currently occupied`);
  }

  const emptyEl = document.getElementById(`empty-${targetId}`);
  if (emptyEl) emptyEl.style.display = 'none';
  appendTransmissionMsg(targetId, callerName, message);

  state.conversations[targetId].push({ role: 'user', content: `[Transmission from ${callerName}] ${message}` });

  // Pause the caller's thinking timer so colony_ask doesn't trigger a false timeout
  const callerTimer = thinkingTimers[callerPersonaId];
  if (callerTimer) {
    clearTimeout(callerTimer);
    thinkingTimers[callerPersonaId] = null;
  }

  setThinking(targetId, true);

  let result;
  try {
    result = await Promise.race([
      _callPersonaOnce(targetId, []),  // no tools — no recursion
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${targetPersona.name} timed out after ${COLONY_ASK_TIMEOUT_MS / 1000}s`)),
          COLONY_ASK_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    setThinking(targetId, false);
    restoreCallerTimer(callerPersonaId);
    return `Error: ${err.message}`;
  }

  setThinking(targetId, false);
  restoreCallerTimer(callerPersonaId);

  if (!result) return `Error: ${targetPersona.name} did not respond`;

  const responseText = result.text ?? '[no response]';
  if (result.responseId) state.lastResponseId[targetId] = result.responseId;

  state.conversations[targetId].push({ role: 'assistant', content: responseText });
  appendAssistantMsg(targetId, responseText, result.reasoning ?? null, result.stats ?? null);

  return responseText;
}

// Re-arm the caller's thinking timer with a fresh window after colony_ask completes
function restoreCallerTimer(id) {
  if (!state.thinking[id]) return;
  const maxSecs = state.config.settings?.maxThinkingTime ?? 120;
  if (maxSecs <= 0) return;
  if (thinkingTimers[id]) clearTimeout(thinkingTimers[id]);
  thinkingTimers[id] = setTimeout(() => {
    if (state.thinking[id]) {
      const ind = document.getElementById(`thinking-${id}`);
      if (ind) {
        const label = document.createElement('div');
        label.className = 'timeout-label';
        label.textContent = '⏱ generation running longer than expected…';
        ind.appendChild(label);
      }
    }
  }, maxSecs * 1000);
}
