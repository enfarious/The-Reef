// ─── The Reef Colony Interface — Orchestrator ─────────────────────────────────
//
// This is the main entry point.  All domain logic lives in renderer/lib/*.
// This file contains the core orchestration loop (sendToPersona, LLM call
// wrappers, message routing) and the init() bootstrap.

import { PERSONAS, state }                                    from './lib/state.js';
import { uid, escHtml, formatMd, timestamp, resizeTextarea }  from './lib/utils.js';
import { acquireLlmSlot, releaseLlmSlot, TOOL_CHAIN_YIELD_STEPS } from './lib/concurrency.js';
import { abortFlags, activeStreams, abortPersona, getMaxToolSteps } from './lib/abort.js';
import { applyFontScale, applyTextColors, applyColonyName }   from './lib/color.js';
import { buildColony, buildTargetButtons }                     from './lib/colony-ui.js';
import { scheduleSave, applyConfig, initConfigListeners }      from './lib/config.js';
import {
  setCompactCallback, getContextWindow, maybeAutoCompact,
  COMPACT_PROMPT, updateContextCounter, buildOperatorSection,
  buildWorkspaceSection, buildSessionSection, scanProject, updateCwdDisplay, personaHasApiAccess,
} from './lib/context.js';
import { setHeartbeatCallbacks, runHeartbeatFor, startHeartbeat, HEARTBEAT_PROMPT } from './lib/heartbeat.js';
import { parseAtMentions }                                     from './lib/mentions.js';
import { TOOL_DEFS, contextualToolDefs, detectModeClient }     from './lib/tools.js';
import {
  setAbortCallback, appendUserMsg, appendAssistantMsg, appendError,
  appendToolTextMsg, appendToolCallIndicator, appendToolResultIndicator,
  appendOperatorBadge, setThinking, finalizeStreamingBubble,
  adoptBubbleAsAccumulator, clearToolAccumulator,
} from './lib/messages-ui.js';
import { setToolExecCallbacks, executeTool }                   from './lib/tool-exec.js';
import { setSchedulerCallbacks }                               from './lib/scheduler.js';
import {
  openEntitySettings, openReefPost,
  initConfirmModal, initEntitySettingsListeners,
} from './lib/modals.js';

// ─── Per-persona message queue ───────────────────────────────────────────────
const messageQueue = { A: [], B: [], C: [] };

// ─── Messaging — user input entry point ──────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('userInput');
  const raw   = input.value.trim();
  if (!raw) return;

  const mentioned = parseAtMentions(raw);
  const targets   = mentioned
    ? mentioned.targets
    : state.selectedTargets.has('ALL') ? ['A', 'B', 'C'] : [...state.selectedTargets];

  if (!targets.length) return;

  const cleanText = mentioned?.cleanText || raw;
  if (!cleanText) return;

  input.value = '';
  resizeTextarea(input);

  targets.forEach(id => {
    if (state.thinking[id]) {
      messageQueue[id].push({ display: raw, content: cleanText });
      const msgs = document.getElementById(`msgs-${id}`);
      if (msgs) {
        const seam = document.createElement('div');
        seam.className = 'queued-seam';
        seam.textContent = `⧗ QUEUED${messageQueue[id].length > 1 ? ` ×${messageQueue[id].length}` : ''}`;
        msgs.appendChild(seam);
        msgs.scrollTop = msgs.scrollHeight;
      }
    } else {
      (async () => {
        await maybeAutoCompact(id);
        appendUserMsg(id, raw, cleanText);
        sendToPersona(id).finally(() => drainMessageQueue(id));
      })();
    }
  });
}

async function drainMessageQueue(id) {
  while (messageQueue[id].length > 0) {
    if (state.thinking[id]) return;
    const { display, content } = messageQueue[id].shift();
    await maybeAutoCompact(id);
    appendUserMsg(id, display, content);
    await sendToPersona(id);
  }
}

// ─── Context compaction ──────────────────────────────────────────────────────

async function compactPersona(id) {
  if (state.thinking[id]) return;
  const count = state.conversations[id].length;
  if (!count) return;

  state.conversations[id].push({ _id: uid(), role: 'user', content: COMPACT_PROMPT });

  const msgs = document.getElementById(`msgs-${id}`);
  const seam = document.createElement('div');
  seam.className = 'compact-seam compacting';
  seam.id = `seam-${id}`;
  seam.textContent = '⊡ COMPACTING…';
  msgs.appendChild(seam);
  msgs.scrollTop = msgs.scrollHeight;

  await sendToPersona(id);

  state.conversations[id]  = [];
  state.lastResponseId[id] = null;
  state.lastTokens[id]     = null;

  seam.classList.remove('compacting');
  seam.textContent = `⊡ COMPACTED · ${count} messages cleared · summary saved to memory`;
  updateContextCounter(id);
}

// ─── Tool-use loop — main orchestrator ───────────────────────────────────────

async function sendToPersona(id, { isHeartbeat = false, heartbeatPrompt = null } = {}) {
  if (state.thinking[id]) return;

  const endpoint = document.getElementById(`endpoint-${id}`).value.trim();
  const mode     = detectModeClient(endpoint);

  const useTools = mode !== 'lmstudio-v1';
  const stepCap  = useTools ? getMaxToolSteps() : 0;

  let v1Integrations;
  if (mode === 'lmstudio-v1' && state.mcpPort) {
    const toolStates = state.config.settings.toolStates || {};
    const enabledMcpTools = TOOL_DEFS
      .filter(t => t.skillName)
      .filter(t => isHeartbeat ? t.name !== 'reef_post' : true)
      .filter(t => toolStates[t.name] !== false)
      .map(t => t.name);

    if (enabledMcpTools.length) {
      v1Integrations = [{
        type:          'ephemeral_mcp',
        server_label:  'reef',
        server_url:    `http://127.0.0.1:${state.mcpPort}`,
        allowed_tools: enabledMcpTools,
      }];
    }
  }

  const useStreaming = state.config.settings.streamChat === true;

  const localMessages = isHeartbeat ? [{ role: 'user', content: heartbeatPrompt || HEARTBEAT_PROMPT }] : null;

  const callOpts = isHeartbeat
    ? { messages: localMessages, previousResponseId: undefined,
        store: false, suppressResponseId: true, suppressStats: true }
    : {};

  setThinking(id, true);

  let toolCallsExecuted = 0;

  for (let step = 0; ; step++) {
    if (abortFlags[id]) { abortFlags[id] = false; break; }

    const isLastStep = toolCallsExecuted >= stepCap;
    const tools = (useTools && !isLastStep)
      ? contextualToolDefs(id, isHeartbeat ? localMessages : state.conversations[id], { heartbeat: isHeartbeat })
      : [];

    const result = useStreaming
      ? await callPersonaStream(id, tools, v1Integrations, callOpts)
      : await callPersonaOnce(id, tools, v1Integrations, callOpts);
    if (!result) {
      clearToolAccumulator(id);
      setThinking(id, false);
      if (!isHeartbeat) state.lastActivity[id] = Date.now();
      updateContextCounter(id);
      return;
    }

    const { text, toolUse, rawContent, reasoning, stats, responseId, mode: respMode } = result;

    if (!isHeartbeat) {
      if (responseId) state.lastResponseId[id] = responseId;
      if (stats?.inputTokens != null) {
        state.lastTokens[id] = { inputTokens: stats.inputTokens, outputTokens: stats.outputTokens ?? null };
      }
    }

    // ── No tool calls (or last step) — render final response and stop ────────
    if (!toolUse?.length || isLastStep) {
      // Server-side tool calls (LM Studio v1) — accumulate before message
      if (result.serverToolCalls?.length) {
        for (const tc of result.serverToolCalls) {
          const name  = tc.tool ?? tc.name ?? 'tool';
          const input = tc.arguments ?? tc.input ?? {};
          appendToolCallIndicator(id, name, input);
          if (tc.output != null) {
            appendToolResultIndicator(id, name, String(tc.output));
          }
        }
      }

      if (text) {
        const msgId = uid();
        let aDiv;
        if (result._bubble) {
          aDiv = finalizeStreamingBubble(id, result._bubble, text, reasoning ?? null, stats ?? null);
        } else {
          aDiv = appendAssistantMsg(id, text, reasoning ?? null, stats ?? null);
        }
        if (!isHeartbeat) {
          state.conversations[id].push({ _id: msgId, role: 'assistant', content: text });
          if (aDiv) { aDiv.dataset.personaId = id; aDiv.dataset.msgId = msgId; }
        }
      } else if (result._bubble) {
        result._bubble.remove();
      }

      clearToolAccumulator(id);
      setThinking(id, false);
      if (!isHeartbeat) state.lastActivity[id] = Date.now();
      updateContextCounter(id);
      return;
    }

    // ── Tool calls present — push assistant turn, execute, loop ─────────────
    if (result._bubble) {
      adoptBubbleAsAccumulator(id, result._bubble, text || null);
    } else if (text) {
      appendToolTextMsg(id, text);
    }

    if (respMode === 'anthropic') {
      if (isHeartbeat) {
        localMessages.push({ role: 'assistant', content: rawContent });
      } else {
        state.conversations[id].push({ _id: uid(), role: 'assistant', content: rawContent });
      }
    } else {
      if (isHeartbeat) {
        localMessages.push({ role: 'assistant', content: text ?? '', tool_calls: rawContent.tool_calls });
      } else {
        state.conversations[id].push({
          _id: uid(), role: 'assistant',
          content: text ?? '',
          tool_calls: rawContent.tool_calls,
        });
      }
    }

    toolCallsExecuted += toolUse.length;
    const toolResults = [];
    for (const tc of toolUse) {
      if (!result._streamedToolIds?.has(tc.id ?? tc.name)) {
        appendToolCallIndicator(id, tc.name, tc.input);
      }
      let resultStr;
      let imageData = null;
      try {
        const raw = await executeTool(id, tc);
        if (raw && typeof raw === 'object' && raw.__vision) {
          imageData = { base64: raw.base64, mimeType: raw.mimeType };
          resultStr = raw.description;
        } else {
          resultStr = raw;
        }
      } catch (err) {
        resultStr = `Error: ${err.message}`;
      }
      appendToolResultIndicator(id, tc.name, resultStr);
      toolResults.push({ id: tc.id, content: resultStr, image: imageData });
    }

    if (respMode === 'anthropic') {
      const toolResultMsg = {
        role: 'user',
        content: toolResults.map(r => ({
          type:        'tool_result',
          tool_use_id: r.id,
          content:     r.image
            ? [
                { type: 'image', source: { type: 'base64', media_type: r.image.mimeType, data: r.image.base64 } },
                { type: 'text', text: r.content },
              ]
            : r.content,
        })),
      };
      if (isHeartbeat) {
        localMessages.push(toolResultMsg);
      } else {
        state.conversations[id].push({ _id: uid(), ...toolResultMsg });
      }
    } else {
      const pendingImages = [];
      for (const r of toolResults) {
        const toolMsg = { role: 'tool', tool_call_id: r.id, content: r.content };
        if (isHeartbeat) {
          localMessages.push(toolMsg);
        } else {
          state.conversations[id].push({ _id: uid(), ...toolMsg });
        }
        if (r.image) pendingImages.push(r.image);
      }
      if (pendingImages.length) {
        const imageMsg = {
          role: 'user',
          content: [
            { type: 'text', text: 'Here are the captured image(s) from the tool(s) above:' },
            ...pendingImages.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ],
        };
        if (isHeartbeat) {
          localMessages.push(imageMsg);
        } else {
          state.conversations[id].push({ _id: uid(), ...imageMsg });
        }
      }
    }

    if ((step + 1) % TOOL_CHAIN_YIELD_STEPS === 0) {
      await new Promise(r => setTimeout(r, 0));
    }

    if (toolCallsExecuted >= stepCap + 20) {
      abortPersona(id, `⚠ TOOL LIMIT: ${toolCallsExecuted} calls executed`);
      break;
    }
  }

  clearToolAccumulator(id);
  setThinking(id, false);
  if (!isHeartbeat) state.lastActivity[id] = Date.now();
  updateContextCounter(id);
}

// ─── Single LLM call ─────────────────────────────────────────────────────────

async function callPersonaOnce(id, tools = [], integrations = undefined, opts = {}) {
  const endpoint     = document.getElementById(`endpoint-${id}`).value.trim();
  const model        = document.getElementById(`model-${id}`).value;
  const entityPrompt = (state.config[id].systemPrompt || '').trim();
  const basePrompt   = (state.config.settings.baseSystemPrompt || '').trim();

  let systemPrompt = basePrompt ? basePrompt + '\n\n' + entityPrompt : entityPrompt;
  const operatorSection  = buildOperatorSection();
  const sessionSection   = buildSessionSection();
  const workspaceSection = buildWorkspaceSection();
  if (operatorSection)  systemPrompt += '\n\n' + operatorSection;
  if (sessionSection)   systemPrompt += '\n\n' + sessionSection;
  if (workspaceSection) systemPrompt += '\n\n' + workspaceSection;

  const apiKey = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();

  const previousResponseId = ('previousResponseId' in opts)
    ? opts.previousResponseId
    : (state.lastResponseId[id] || undefined);
  const messages = opts.messages !== undefined
    ? opts.messages
    : state.conversations[id].map(({ _id, ...m }) => m);

  await acquireLlmSlot();
  let response;
  try {
    response = await window.reef.invoke('llm.complete', {
      endpoint, model, systemPrompt, apiKey, messages, previousResponseId,
      tools:        tools.length  ? tools        : undefined,
      integrations: integrations  ? integrations : undefined,
      ...(opts.store === false ? { store: false } : {}),
    });
  } finally {
    releaseLlmSlot();
  }

  if (!response.ok) {
    appendError(id, response.error);
    return null;
  }
  return response.result;
}

// ─── Streaming single LLM call ──────────────────────────────────────────────

async function callPersonaStream(id, tools = [], integrations = undefined, opts = {}) {
  const endpoint     = document.getElementById(`endpoint-${id}`).value.trim();
  const model        = document.getElementById(`model-${id}`).value;
  const entityPrompt = (state.config[id].systemPrompt || '').trim();
  const basePrompt   = (state.config.settings.baseSystemPrompt || '').trim();

  let systemPrompt = basePrompt ? basePrompt + '\n\n' + entityPrompt : entityPrompt;
  const operatorSection  = buildOperatorSection();
  const sessionSection   = buildSessionSection();
  const workspaceSection = buildWorkspaceSection();
  if (operatorSection)  systemPrompt += '\n\n' + operatorSection;
  if (sessionSection)   systemPrompt += '\n\n' + sessionSection;
  if (workspaceSection) systemPrompt += '\n\n' + workspaceSection;

  const apiKey = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();

  const previousResponseId = ('previousResponseId' in opts)
    ? opts.previousResponseId
    : (state.lastResponseId[id] || undefined);
  const messages = opts.messages !== undefined
    ? opts.messages
    : state.conversations[id].map(({ _id, ...m }) => m);

  const streamId = `stream_${id}_${Date.now()}`;

  const endpointMode = detectModeClient(endpoint);
  activeStreams[id] = {
    abort: () => window.reef.abortStream(streamId),
    getMode: () => endpointMode,
  };

  const msgs = document.getElementById(`msgs-${id}`);
  const bubble = document.createElement('div');
  bubble.className = 'message assistant-msg streaming-bubble';
  bubble.innerHTML = `
    <div class="stream-reasoning-wrap" style="display:none">
      <div class="stream-reasoning-hdr">▸ REASONING</div>
      <div class="stream-reasoning-body"></div>
    </div>
    <div class="stream-tool-strip" style="display:none"></div>
    <div class="stream-text-wrap" style="display:none">
      <span class="stream-text"></span><span class="stream-cursor">▌</span>
    </div>`;

  const thinkInd = document.getElementById(`thinking-${id}`);
  if (thinkInd) msgs.insertBefore(bubble, thinkInd);
  else          msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;

  const streamTextEl     = bubble.querySelector('.stream-text');
  const streamTextWrap   = bubble.querySelector('.stream-text-wrap');
  const streamReasonEl   = bubble.querySelector('.stream-reasoning-body');
  const streamReasonWrap = bubble.querySelector('.stream-reasoning-wrap');
  const streamToolStrip  = bubble.querySelector('.stream-tool-strip');
  let accText      = '';
  let accReasoning = '';

  const removeListener = window.reef.onStreamEvent((evtId, chunk) => {
    if (evtId !== streamId) return;
    switch (chunk.type) {
      case 'text':
        accText += chunk.delta;
        if (streamTextEl) {
          streamTextEl.textContent = accText;
          // Show text wrap only once non-whitespace content arrives
          if (streamTextWrap.style.display === 'none' && accText.trim()) {
            streamTextWrap.style.display = '';
          }
          msgs.scrollTop = msgs.scrollHeight;
        }
        break;
      case 'reasoning':
        accReasoning += chunk.delta;
        if (streamReasonWrap.style.display === 'none') {
          streamReasonWrap.style.display = '';
        }
        if (streamReasonEl) streamReasonEl.textContent = accReasoning;
        break;
      case 'tool_start':
        if (streamToolStrip && chunk.name) {
          streamToolStrip.style.display = '';
          streamToolStrip.textContent = `▶ ${chunk.name}…`;
        }
        break;
      case 'tool_done':
        // Hide the "in progress" strip
        if (streamToolStrip) streamToolStrip.style.display = 'none';
        if (chunk.name) {
          const tcuid = `tc-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const display = chunk.name.replace(/_/g, '.');
          const args = JSON.stringify(chunk.input ?? {}, null, 2);
          const block = document.createElement('div');
          block.className = 'reasoning-block tool-call-block';
          block.id = tcuid;
          block.innerHTML = `
            <button class="reasoning-toggle tool-toggle" data-block-toggle="${tcuid}">
              <span class="reasoning-arrow">▸</span> ⟐ ${escHtml(display)}
            </button>
            <div class="reasoning-body">${escHtml(args)}</div>`;
          // Insert before the streaming elements (tools appear at top)
          const firstStreamEl = bubble.querySelector('.stream-reasoning-wrap')
            || bubble.querySelector('.stream-tool-strip')
            || bubble.querySelector('.stream-text-wrap');
          if (firstStreamEl) bubble.insertBefore(block, firstStreamEl);
          else                bubble.appendChild(block);
          if (!bubble._streamedToolIds) bubble._streamedToolIds = new Set();
          bubble._streamedToolIds.add(chunk.id ?? chunk.name);
          msgs.scrollTop = msgs.scrollHeight;
        }
        break;
      case 'stats':
        if (chunk.inputTokens != null && !opts.suppressStats) {
          state.lastTokens[id] = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens ?? null };
        }
        break;
      case 'response_id':
        if (!opts.suppressResponseId) state.lastResponseId[id] = chunk.id;
        break;
    }
  });

  await acquireLlmSlot();
  let response;
  try {
    response = await window.reef.streamLLM(streamId, {
      endpoint, model, systemPrompt, apiKey, messages, previousResponseId,
      tools:        tools.length  ? tools        : undefined,
      integrations: integrations  ? integrations : undefined,
      ...(opts.store === false ? { store: false } : {}),
    });
  } finally {
    releaseLlmSlot();
    activeStreams[id] = null;
  }

  removeListener();

  if (!response.ok) {
    bubble.remove();
    if (!response.aborted && response.error) appendError(id, response.error);
    return null;
  }

  const result = response.result;
  result._bubble = bubble;
  if (bubble._streamedToolIds) result._streamedToolIds = bubble._streamedToolIds;
  return result;
}

// ─── Model refresh ───────────────────────────────────────────────────────────

async function refreshModels(id) {
  const endpoint = document.getElementById(`endpoint-${id}`).value.trim();
  const apiKey   = document.getElementById(`apikey-${id}`).value.trim()
    || document.getElementById('globalApiKey').value.trim();
  const btn      = document.querySelector(`[data-persona-refresh="${id}"]`);

  if (!endpoint) { appendError(id, 'Set an endpoint first.'); return; }

  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  const result = await window.reef.invoke('llm.models', { endpoint, apiKey });

  if (btn) { btn.textContent = '⟳'; btn.disabled = false; }

  if (!result.ok) {
    appendError(id, `Model fetch: ${result.error}`);
    return;
  }

  const models = result.result;
  if (!models.length) {
    appendError(id, 'No models returned from endpoint.');
    return;
  }

  const select     = document.getElementById(`model-${id}`);
  const currentVal = select.value;
  select.innerHTML = '';

  const sorted = [...models].sort((a, b) => {
    if (a.state === 'loaded' && b.state !== 'loaded') return -1;
    if (a.state !== 'loaded' && b.state === 'loaded') return 1;
    return a.id.localeCompare(b.id);
  });

  sorted.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const dot   = m.state === 'loaded' ? '● ' : '○ ';
    const quant = m.quantization ? ` [${m.quantization}]` : '';
    opt.textContent = dot + m.id + quant;
    if (m.state !== 'loaded') opt.style.opacity = '0.5';
    select.appendChild(opt);
  });

  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'custom…';
  select.appendChild(customOpt);

  const ids = sorted.map(m => m.id);
  if (ids.includes(currentVal)) {
    select.value = currentVal;
  } else {
    const firstLoaded = sorted.find(m => m.state === 'loaded');
    select.value = firstLoaded ? firstLoaded.id : sorted[0]?.id || 'custom';
  }

  state.modelList[id]  = models;
  const selectedModel   = models.find(m => m.id === select.value);
  state.maxContext[id]  = selectedModel?.maxContext ?? null;
  updateContextCounter(id);
  scheduleSave();
}

// ─── Wakeup ritual ───────────────────────────────────────────────────────────

let entitySettingsPersonaId = null;

async function wakePersona(id) {
  const persona     = PERSONAS.find(p => p.id === id);
  const personaName = state.config[id].name || persona.name;
  const msgs = document.getElementById(`msgs-${id}`);
  const empty = document.getElementById(`empty-${id}`);
  if (empty) empty.style.display = 'none';

  const wakeBtn = document.querySelector(`[data-persona-wake="${id}"]`);
  if (wakeBtn) { wakeBtn.classList.remove('wake-lit'); wakeBtn.textContent = '⟳ WAKE'; }

  const wakeEl = document.createElement('div');
  wakeEl.className = 'message assistant-msg';
  wakeEl.id = `waking-${id}`;
  wakeEl.innerHTML = `<div class="skill-indicator">⟳ REINTEGRATING MEMORY…</div>`;
  msgs.appendChild(wakeEl);
  msgs.scrollTop = msgs.scrollHeight;

  const memBudget = Math.floor(getContextWindow() * 0.30);

  const result = await window.reef.invoke('memory.wakeup', {
    persona:     personaName.toLowerCase(),
    limit:       10,
    tokenBudget: memBudget,
  });

  const indicator = document.getElementById(`waking-${id}`);
  if (indicator) indicator.remove();

  if (!result.ok) {
    appendError(id, `Wakeup failed: ${result.error}`);
    appendOperatorBadge(id, msgs);
    return;
  }

  const { memories, contextBlock } = result.result;

  if (!memories.length) {
    if (wakeBtn) { wakeBtn.classList.add('wake-lit'); wakeBtn.textContent = '✓ AWAKE'; }
    const div = document.createElement('div');
    div.className = 'message assistant-msg';
    div.innerHTML = `<div class="skill-indicator">◈ no memories found — ${escHtml(personaName)} begins fresh</div>`;
    msgs.appendChild(div);
    appendOperatorBadge(id, msgs);
    msgs.scrollTop = msgs.scrollHeight;
    if (!state.conversations[id].length && personaHasApiAccess(id)) {
      state.conversations[id].push({ _id: uid(), role: 'user',
        content: '[SESSION START] You are waking fresh, without memories yet. Greet the colony and introduce yourself.' });
      sendToPersona(id);
    }
    return;
  }

  const existing = (state.config[id].systemPrompt || '').trim();
  const stripped = existing.replace(/\n\n--- MEMORY REINTEGRATION[\s\S]*?---\s*$/, '').trim();
  state.config[id].systemPrompt = stripped + '\n\n' + contextBlock;
  if (entitySettingsPersonaId === id) {
    const ta = document.getElementById('entitySystemPrompt');
    if (ta) ta.value = state.config[id].systemPrompt;
  }
  scheduleSave();

  if (wakeBtn) { wakeBtn.classList.add('wake-lit'); wakeBtn.textContent = '✓ AWAKE'; }

  const div = document.createElement('div');
  div.className = 'message assistant-msg';
  const memList = memories.slice(0, 3).map(m =>
    `<span style="opacity:0.6">[${escHtml(m.type)}]</span> ${escHtml(m.title || m.subject || m.body.slice(0, 60))}`
  ).join('<br>');
  div.innerHTML = `
    <div class="skill-indicator">
      ✓ ${memories.length} memories reintegrated into ${escHtml(personaName)}<br>
      <div style="margin-top:4px;font-size:0.85em;opacity:0.7;">${memList}${memories.length > 3 ? `<br><span style="opacity:0.5">…+${memories.length - 3} more</span>` : ''}</div>
    </div>`;
  msgs.appendChild(div);
  appendOperatorBadge(id, msgs);
  msgs.scrollTop = msgs.scrollHeight;

  if (!state.conversations[id].length && personaHasApiAccess(id)) {
    state.conversations[id].push({ _id: uid(), role: 'user',
      content: '[SESSION START] Your memories have been reintegrated. Greet the colony.' });
    sendToPersona(id);
  }
}

async function wakeAll() {
  const btn = document.getElementById('wakeAllBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ WAKING…'; btn.classList.remove('wake-all-lit'); }
  await Promise.all(PERSONAS.map(p => wakePersona(p.id)));
  if (btn) { btn.disabled = false; btn.textContent = '⟳ WAKE ALL'; btn.classList.add('wake-all-lit'); }
}

// ─── Claude CLI proxy resolution ─────────────────────────────────────────────

function resolveClaudeCliEndpoints() {
  if (!state.claudeProxyEndpoint) return;
  PERSONAS.forEach(p => {
    const input = document.getElementById(`endpoint-${p.id}`);
    if (!input) return;
    if (input.value === 'claude-cli' || input.dataset.claudeCli === '1') {
      input.value       = state.claudeProxyEndpoint;
      input.placeholder = '';
      input.dataset.claudeCli = '1';
      input.title = `Claude CLI OAuth proxy \u2014 ${state.claudeProxyEndpoint}`;
    }
    input.classList.toggle('oauth-proxy-active', input.dataset.claudeCli === '1');
  });
}

// ─── Event delegation ────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  if (e.target.matches('.target-btn')) {
    const t = e.target.dataset.target;
    if (t === 'ALL') {
      if (state.selectedTargets.has('ALL')) {
        state.selectedTargets.clear();
      } else {
        state.selectedTargets.clear();
        state.selectedTargets.add('ALL');
      }
    } else {
      state.selectedTargets.delete('ALL');
      if (state.selectedTargets.has(t)) {
        state.selectedTargets.delete(t);
      } else {
        state.selectedTargets.add(t);
      }
    }
    document.querySelectorAll('.target-btn').forEach(btn => {
      btn.classList.toggle('selected', state.selectedTargets.has(btn.dataset.target));
    });
    PERSONAS.forEach(p => {
      const targeted = state.selectedTargets.has(p.id) || state.selectedTargets.has('ALL');
      document.getElementById(`col-${p.id}`).classList.toggle('active-col', targeted);
    });
  }

  if (e.target.closest('[data-block-toggle]')) {
    const blockUid = e.target.closest('[data-block-toggle]').dataset.blockToggle;
    const block    = document.getElementById(blockUid);
    if (block) block.classList.toggle('open');
    return;
  }

  if (e.target.matches('[data-entity-settings]')) {
    entitySettingsPersonaId = e.target.dataset.entitySettings;
    openEntitySettings(e.target.dataset.entitySettings, e.target);
  }

  if (e.target.matches('[data-persona-post]')) {
    openReefPost(e.target.dataset.personaPost);
  }

  if (e.target.matches('[data-persona-wake]')) {
    wakePersona(e.target.dataset.personaWake);
  }

  if (e.target.matches('[data-persona-pulse]')) {
    runHeartbeatFor(e.target.dataset.personaPulse);
  }

  if (e.target.matches('[data-persona-fold]')) {
    compactPersona(e.target.dataset.personaFold);
  }

  if (e.target.matches('[data-persona-stop]')) {
    const sid = e.target.dataset.personaStop;
    if (state.thinking[sid]) abortPersona(sid, '✕ INTERRUPTED');
  }

  if (e.target.matches('[data-persona-refresh]')) {
    refreshModels(e.target.dataset.personaRefresh);
  }

  if (e.target.id === 'wakeAllBtn') {
    wakeAll();
  }
});

// ─── Settings window ─────────────────────────────────────────────────────────

document.getElementById('settingsBtn').addEventListener('click', () => {
  window.reef.openWindow('settings');
});

window.reef.onConfigUpdated(cfg => {
  if (!cfg?.settings) return;
  const prev = state.config.settings.heartbeatInterval;

  if (cfg.database) {
    const prevDb = state.config.database || {};
    const newDb  = cfg.database;
    const dbChanged = ['host', 'port', 'database', 'user', 'password'].some(
      k => newDb[k] !== undefined && String(newDb[k]) !== String(prevDb[k] ?? '')
    );
    if (dbChanged && !document.getElementById('dbRestartBanner')) {
      const banner = document.createElement('div');
      banner.id = 'dbRestartBanner';
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
        'background:rgba(40,30,10,0.97)', 'border-bottom:1px solid rgba(255,160,40,0.4)',
        'color:rgba(255,190,70,0.95)', 'font-family:monospace', 'font-size:0.7rem',
        'padding:7px 16px', 'letter-spacing:0.04em', 'display:flex',
        'align-items:center', 'gap:12px',
      ].join(';');
      banner.innerHTML = `<span>⚠ Database settings changed — restart required to reconnect.</span>
        <button onclick="this.parentElement.remove()" style="margin-left:auto;background:none;border:none;color:inherit;cursor:pointer;opacity:0.6;font-size:1rem;">✕</button>`;
      document.body.prepend(banner);
    }
    state.config.database = { ...(state.config.database || {}), ...newDb };
  }

  state.config.settings = { ...state.config.settings, ...cfg.settings };
  if (cfg.settings.fontScale  !== undefined) applyFontScale(cfg.settings.fontScale);
  if (cfg.settings.fontColors !== undefined) applyTextColors(cfg.settings.fontColors);
  applyColonyName(state.config.settings.colonyName);
  if (cfg.settings.heartbeatInterval !== undefined &&
      cfg.settings.heartbeatInterval !== prev) {
    startHeartbeat();
  }
  if (cfg.settings.cwd !== undefined) {
    const newCwd = cfg.settings.cwd || null;
    if (newCwd !== state.cwd) {
      state.cwd = newCwd;
      updateCwdDisplay();
      scanProject(newCwd);
    }
  }
});

// ─── Send button / keyboard ──────────────────────────────────────────────────

document.getElementById('sendBtn').addEventListener('click', sendMessage);

document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  // Wire callbacks — break circular dependencies
  setCompactCallback(compactPersona);
  setAbortCallback(abortPersona);
  setHeartbeatCallbacks({ sendToPersona });
  setSchedulerCallbacks({ sendToPersona, appendUserMsg });
  setToolExecCallbacks({ callPersonaOnce });

  // Build UI
  buildColony();
  buildTargetButtons();
  document.getElementById('col-A').classList.add('active-col');

  // Wire DOM listeners from extracted modules
  initConfigListeners();
  initConfirmModal();
  initEntitySettingsListeners();

  // Start heartbeat
  startHeartbeat();

  // Fetch MCP server port
  window.reef.mcpPort().then(port => {
    state.mcpPort = port;
    if (port) console.log(`[renderer] MCP server available on port ${port}`);
  }).catch(() => {});

  // Fetch Claude CLI proxy info
  window.reef.claudeProxyInfo().then(info => {
    if (info?.endpoint) {
      state.claudeProxyEndpoint = info.endpoint;
      console.log(`[renderer] Claude CLI proxy: ${info.endpoint} — ${info.status?.message}`);
      resolveClaudeCliEndpoints();
    }
  }).catch(() => {});

  // CWD picker
  document.getElementById('cwdPickBtn').addEventListener('click', async () => {
    const result = await window.reef.invoke('fs.pickDir', {});
    if (result.ok && result.result) {
      state.cwd = result.result;
      updateCwdDisplay();
      scanProject(result.result);
      scheduleSave();
    }
  });

  document.getElementById('cwdClearBtn').addEventListener('click', () => {
    state.cwd = null;
    state.projectContext = null;
    updateCwdDisplay();
    scheduleSave();
  });

  // Message edit / delete (delegated)
  document.addEventListener('click', e => {
    const delBtn = e.target.closest('.msg-delete-btn');
    if (delBtn) {
      const msgDiv = delBtn.closest('.message[data-persona-id]');
      if (!msgDiv) return;
      const pid   = msgDiv.dataset.personaId;
      const msgId = msgDiv.dataset.msgId;
      if (!pid || !msgId) return;
      state.conversations[pid] = state.conversations[pid].filter(m => m._id !== msgId);
      msgDiv.remove();
      return;
    }

    const editBtn = e.target.closest('.msg-edit-btn');
    if (editBtn) {
      const msgDiv = editBtn.closest('.message[data-persona-id]');
      if (!msgDiv || msgDiv.dataset.editing) return;

      const pid   = msgDiv.dataset.personaId;
      const msgId = msgDiv.dataset.msgId;
      if (!pid || !msgId) return;

      const entry = state.conversations[pid].find(m => m._id === msgId);
      if (!entry || typeof entry.content !== 'string') return;

      const bubble    = msgDiv.querySelector('.msg-bubble');
      const isUser    = msgDiv.classList.contains('user-msg');
      const savedHtml = bubble.innerHTML;

      msgDiv.dataset.editing = '1';
      bubble.innerHTML = '';

      const ta = document.createElement('textarea');
      ta.className = 'msg-edit-textarea';
      ta.value = entry.content;
      bubble.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      let committed = false;
      const commit = (save) => {
        if (committed) return;
        committed = true;
        delete msgDiv.dataset.editing;
        if (save) {
          const newText = ta.value.trim();
          if (newText) {
            entry.content = newText;
            bubble.innerHTML = isUser ? escHtml(newText) : formatMd(escHtml(newText));
            return;
          }
        }
        bubble.innerHTML = savedHtml;
      };

      ta.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(true); }
        if (ev.key === 'Escape') { commit(false); }
      });
      ta.addEventListener('blur', () => setTimeout(() => commit(true), 60));
    }
  });

  // Inspector window buttons
  document.getElementById('openMemoryBrowser').onclick = () => window.reef.openWindow('memory-browser');
  document.getElementById('openMessages').onclick      = () => window.reef.openWindow('messages');
  document.getElementById('openArchive').onclick       = () => window.reef.openWindow('archive');
  document.getElementById('openVisualizer').onclick    = () => window.reef.openWindow('visualizer');

  // Load saved config
  const saved = await window.reef.loadConfig();
  if (saved && saved.ok) {
    applyConfig(saved.result);
    if (state.claudeProxyEndpoint) resolveClaudeCliEndpoints();
  }

  // Auto-wake all personas on launch
  wakeAll();
}

init();
