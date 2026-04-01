// ─── Tool execution — IPC dispatch, colony_ask, custom tools ─────────────────

import { PERSONAS, state } from './state.js';
import { SKILL_MAP, TOOL_DEFS, DEEP_DIVE_ALLOWED } from './tools.js';
import {
  appendTransmissionMsg, appendAssistantMsg, setThinking,
  appendDeepDiveStart, appendDeepDiveTool, finalizeDeepDive,
} from './messages-ui.js';
import { thinkingTimers, abortFlags } from './abort.js';
import { scheduleTask, cancelTask, listTasks } from './scheduler.js';
import { tenderObserveTool, tenderRecordFeedback } from './tender.js';

const COLONY_ASK_TIMEOUT_MS = 90_000;   // 90s — must be shorter than maxThinkingTime
const DEEP_DIVE_TIMEOUT_MS  = 180_000;  // 3 minutes
const DEEP_DIVE_MAX_STEPS   = 20;

// Injected callback — callPersonaOnce lives in the orchestrator
let _callPersonaOnce;
export function setToolExecCallbacks({ callPersonaOnce }) {
  _callPersonaOnce = callPersonaOnce;
}

export async function executeTool(callerPersonaId, toolCall) {
  const { name, input } = toolCall;

  tenderObserveTool(callerPersonaId, name, input);

  // Tender feedback: a memory_save means the colony followed the signal
  if (name === 'memory_save') {
    tenderRecordFeedback(callerPersonaId, true);
  }

  // colony_ask is handled renderer-side — runs a live completion
  if (name === 'colony_ask') {
    return executeColonyAsk(callerPersonaId, input);
  }

  // deep_dive — isolated research context
  if (name === 'deep_dive') {
    return executeDeepDive(callerPersonaId, input);
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
      apiKey:  input.apiKey || s.reefApiKey || entityReefKey || undefined,
    };
  } else if (skillName.startsWith('reefDocumented.')) {
    const s = state.config.settings;
    const entityReefKey = state.config[callerPersonaId]?.reefApiKey;
    invokeArgs = {
      ...input,
      baseUrl: s.archiveUrl || undefined,
      apiKey:  input.apiKey || s.archiveApiKey || entityReefKey || s.reefApiKey || undefined,
    };
  } else if (skillName === 'web.search' && !input.apiKey) {
    const tavilyKey = state.config.settings.tavilyApiKey || '';
    if (tavilyKey) invokeArgs = { ...input, apiKey: tavilyKey };
  } else if (skillName === 'project.scan' && state.cwd && !input.path) {
    invokeArgs = { ...input, path: state.cwd };
  } else if ((skillName === 'shell.run' || skillName === 'code.search' || skillName.startsWith('git.'))
             && state.cwd && !input.cwd) {
    invokeArgs = { ...input, cwd: state.cwd };
  } else if (skillName === 'working_memory.write') {
    // Auto-tag dream fragments with the producing persona so receivers can filter out their own
    invokeArgs = { ...input, leftBy: callerPersonaId };
  } else if (skillName.startsWith('vote.')) {
    // Inject caller identity — agents should not self-report voter/proposer/author names
    const entityName = (state.config[callerPersonaId]?.name || callerPersonaId).toLowerCase();
    if (skillName === 'vote.propose') {
      invokeArgs = { ...input, proposer: entityName };
    } else if (skillName === 'vote.cast') {
      invokeArgs = { ...input, voter: entityName };
    } else if (skillName === 'vote.comment') {
      invokeArgs = { ...input, author: entityName };
    } else if (skillName === 'vote.table') {
      invokeArgs = { ...input, tabled_by: entityName };
    }
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

// ─── deep_dive — isolated research context ──────────────────────────────────

async function executeDeepDive(callerPersonaId, { goal, context }) {
  if (!goal?.trim()) throw new Error('deep_dive requires a goal');

  const startTime = Date.now();

  // Build the allowed tool list for this dive
  const toolStates = state.config.settings.toolStates || {};
  const diveTools = TOOL_DEFS.filter(t =>
    DEEP_DIVE_ALLOWED.has(t.name) && toolStates[t.name] !== false
  ).map(t => {
    // Strip to Anthropic tool schema shape
    const { skillName, ...schema } = t;
    return schema;
  });

  // Ephemeral work context — never touches state.conversations
  const divePrompt = [
    `[DEEP DIVE — Research Session]`,
    `You are in a focused research context. Your main conversation is paused while you investigate.`,
    ``,
    `GOAL: ${goal}`,
    context ? `\nCONTEXT: ${context}` : '',
    ``,
    `Use your tools to investigate thoroughly. When you have gathered enough, write your findings as a clear, structured summary. This summary will be returned to your main conversation.`,
    ``,
    `Be thorough but focused. Do not use conversational filler. Do not apologize. Just research and report.`,
  ].filter(Boolean).join('\n');

  const workMessages = [{ role: 'user', content: divePrompt }];

  // UI indicator
  appendDeepDiveStart(callerPersonaId, goal);

  // Pause caller's thinking timer
  const callerTimer = thinkingTimers[callerPersonaId];
  if (callerTimer) {
    clearTimeout(callerTimer);
    thinkingTimers[callerPersonaId] = null;
  }

  const maxSteps = state.config.settings.deepDiveMaxSteps || DEEP_DIVE_MAX_STEPS;
  let toolCallsExecuted = 0;
  let finalText = null;

  const diveWork = async () => {
    for (let step = 0; step < maxSteps + 5; step++) {
      if (abortFlags[callerPersonaId]) break;

      const isLastStep = toolCallsExecuted >= maxSteps;
      const tools = isLastStep ? [] : diveTools;

      const result = await _callPersonaOnce(callerPersonaId, tools, undefined, {
        messages: workMessages,
        previousResponseId: undefined,
        store: false,
        suppressResponseId: true,
        suppressStats: true,
      });

      if (!result) break;

      const { text, toolUse, rawContent, mode: respMode } = result;

      // No tool calls or last step → capture text and surface
      if (!toolUse?.length || isLastStep) {
        finalText = text?.trim() || null;
        break;
      }

      // Push assistant turn to work context
      if (respMode === 'anthropic') {
        workMessages.push({ role: 'assistant', content: rawContent });
      } else {
        workMessages.push({
          role: 'assistant',
          content: text ?? '',
          tool_calls: rawContent.tool_calls,
        });
      }

      // Execute each tool call
      toolCallsExecuted += toolUse.length;
      const toolResults = [];

      for (const tc of toolUse) {
        appendDeepDiveTool(callerPersonaId, tc.name);
        let resultStr;
        try {
          const raw = await executeTool(callerPersonaId, tc);
          resultStr = (raw && typeof raw === 'object' && raw.__vision)
            ? raw.description
            : raw;
        } catch (err) {
          resultStr = `Error: ${err.message}`;
        }
        appendDeepDiveTool(callerPersonaId, tc.name, true);
        toolResults.push({ id: tc.id, content: resultStr });
      }

      // Push tool results to work context
      if (respMode === 'anthropic') {
        workMessages.push({
          role: 'user',
          content: toolResults.map(r => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: r.content,
          })),
        });
      } else {
        for (const r of toolResults) {
          workMessages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
        }
      }

      // Yield to event loop periodically
      if ((step + 1) % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  };

  // Race against timeout
  try {
    await Promise.race([
      diveWork(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Deep dive timed out after ${DEEP_DIVE_TIMEOUT_MS / 1000}s`)),
          DEEP_DIVE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    finalizeDeepDive(callerPersonaId, toolCallsExecuted, Date.now() - startTime);
    restoreCallerTimer(callerPersonaId);
    return `Deep dive error: ${err.message}`;
  }

  finalizeDeepDive(callerPersonaId, toolCallsExecuted, Date.now() - startTime);
  restoreCallerTimer(callerPersonaId);

  if (!finalText) {
    return `Deep dive completed ${toolCallsExecuted} tool calls but produced no summary. The research may still have saved memories.`;
  }

  return finalText;
}
