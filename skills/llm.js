'use strict';

const https = require('https');
const http = require('http');

// ─── Mode detection ───────────────────────────────────────────────────────────
// Returns: 'anthropic' | 'openai' | 'lmstudio' | 'lmstudio-v1'
//
// lmstudio-v1  — /api/v1/chat  (LM Studio 0.4.0+, stateful, input/previous_response_id)
// lmstudio     — /api/v0/...   (LM Studio 0.3.6+, OpenAI-compat with richer metadata)
// openai       — /v1/...       (OpenAI or any OpenAI-compatible endpoint)
// anthropic    — /v1/messages  (Anthropic Claude API)

function detectMode(endpoint) {
  if (endpoint.includes('/v1/messages'))   return 'anthropic';
  if (endpoint.includes('anthropic.com'))  return 'anthropic';
  if (endpoint.includes('/api/v1/chat'))   return 'lmstudio-v1';
  if (endpoint.includes('/api/v0/'))       return 'lmstudio';
  return 'openai';
}

// ─── Request builders ─────────────────────────────────────────────────────────
// `tools` is always in Anthropic format (canonical).
// buildOpenAIRequest converts to OpenAI function-calling format internally.

function buildAnthropicRequest(endpoint, { model, systemPrompt, apiKey, messages, tools }) {
  const body = { model, max_tokens: 2048, messages };
  if (systemPrompt) body.system = systemPrompt;
  if (tools?.length) body.tools = tools;

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  return { url: endpoint, headers, body };
}

function buildOpenAIRequest(endpoint, { model, systemPrompt, apiKey, messages, tools }) {
  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const body = { model, messages: msgs, max_tokens: 2048, stream: false };

  // Convert Anthropic tool schemas → OpenAI function-calling format
  if (tools?.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: {
        name:        t.name,
        description: t.description,
        parameters:  t.input_schema,
      },
    }));
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return { url: endpoint, headers, body };
}

// LM Studio v1 stateful chat.
// - First turn:       { model, input, system_prompt? }
// - Subsequent turns: { model, input, previous_response_id }
// - Ephemeral query:  { model, input, store: false }
//
// LM Studio v1 exposes `system_prompt` as a proper top-level field — sent
// only on the first turn (server holds context on subsequent turns via
// previous_response_id).  Tool use is handled server-side via `integrations`
// (ephemeral MCP / plugins); there is no client-side tool loop for v1.

function buildLMStudioV1Request(endpoint, { model, systemPrompt, apiKey, messages, previousResponseId, store, integrations }) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';

  const body = { model, input: userText };

  // Send system prompt as a dedicated field on the first turn only.
  // Continuation turns omit it — the server already holds the conversation.
  if (systemPrompt && !previousResponseId) body.system_prompt = systemPrompt;

  if (previousResponseId)       body.previous_response_id = previousResponseId;
  if (store === false)          body.store = false;
  // Tool integrations (ephemeral_mcp / plugin) — present on every turn so the
  // model can use tools regardless of whether this is the first call or a
  // continuation.  LM Studio executes the tool calls server-side.
  if (integrations?.length)     body.integrations = integrations;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return { url: endpoint, headers, body };
}

// ─── HTTP helpers (Node, no CORS) ─────────────────────────────────────────────

function httpRequest(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { ...headers },
    };

    if (payload) {
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error?.message || json.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const fetchJson    = (url, headers, body) => httpRequest(url, 'POST', headers, body);
const fetchJsonGet = (url, headers)       => httpRequest(url, 'GET',  headers, null);

// ─── SSE streaming helper ─────────────────────────────────────────────────────
// Sends a POST request and delivers Server-Sent Events to callbacks.
// onEvent(eventType, parsedData) — called for each SSE data line
// onEnd()   — called when the stream closes cleanly
// onError(err) — called on network/HTTP errors
// Returns the raw http.ClientRequest so the caller can abort if needed.

function httpStream(url, headers, body, { onEvent, onEnd, onError }) {
  const parsed  = new URL(url);
  const lib     = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify(body);

  const opts = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'POST',
    headers: {
      ...headers,
      'Content-Type':   'application/json',
      'Accept':         'text/event-stream',
      'Cache-Control':  'no-cache',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  let finished = false;

  const req = lib.request(opts, (res) => {
    if (res.statusCode >= 400) {
      let errBody = '';
      res.on('data', c => { errBody += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(errBody);
          onError(new Error(j.error?.message || j.message || `HTTP ${res.statusCode}`));
        } catch {
          onError(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`));
        }
      });
      return;
    }

    let buf       = '';
    let eventType = '';

    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';   // last incomplete line back to buffer

      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const text = line.slice(5).trim();
          if (text === '[DONE]') {
            if (!finished) { finished = true; onEnd(); }
            return;
          }
          try { onEvent(eventType || 'data', JSON.parse(text)); } catch { /* ignore malformed */ }
          eventType = '';
        } else if (line === '') {
          eventType = '';   // blank line resets event type
        }
      }
    });

    res.on('end', () => { if (!finished) { finished = true; onEnd(); } });
  });

  req.on('error', (err) => { if (!finished) { finished = true; onError(err); } });
  req.write(payload);
  req.end();
  return req;
}

// ─── Per-mode streaming parsers ───────────────────────────────────────────────
// Each emits normalised chunk events via onChunk, then resolves with the unified
// result object (same shape as the non-streaming parsers).
//
// Normalised chunk types:
//   { type: 'text',      delta }                  — text token
//   { type: 'reasoning', delta }                  — thinking/reasoning token
//   { type: 'tool_start', id, name }              — tool call beginning (name known)
//   { type: 'tool_done',  id, name, input }       — tool call complete (full input)
//   { type: 'stats',      inputTokens, outputTokens, extra } — token counts
//   { type: 'response_id', id }                   — LM Studio v1 response_id
//   { type: 'done' }                              — stream finished
//   { type: 'error',     message }                — error

function streamOpenAI(request, onChunk, resolve, reject, mode) {
  const accText  = [];
  const accReason = [];
  // tool_calls indexed by tc.index
  const toolMap  = new Map();   // index → { id, name, args }
  let inputTokens  = null;
  let outputTokens = null;

  httpStream(request.url, request.headers, request.body, {
    onEvent: (_evtType, data) => {
      // Some endpoints send a final chunk with only usage info and no choices
      if (!data.choices?.length) {
        if (data.usage) {
          inputTokens  = data.usage.prompt_tokens     ?? inputTokens;
          outputTokens = data.usage.completion_tokens ?? outputTokens;
          onChunk({ type: 'stats', inputTokens, outputTokens });
        }
        return;
      }

      const choice = data.choices[0];
      const delta  = choice?.delta ?? {};

      // ── Reasoning content (DeepSeek R1 / QwQ via reasoning_content field) ──
      if (delta.reasoning_content != null && delta.reasoning_content !== '') {
        accReason.push(delta.reasoning_content);
        onChunk({ type: 'reasoning', delta: delta.reasoning_content });
      }

      // ── Text content ──────────────────────────────────────────────────────
      if (delta.content != null && delta.content !== '') {
        accText.push(delta.content);
        onChunk({ type: 'text', delta: delta.content });
      }

      // ── Tool call deltas ──────────────────────────────────────────────────
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          if (!toolMap.has(tc.index)) {
            toolMap.set(tc.index, { id: '', name: '', args: '' });
          }
          const entry = toolMap.get(tc.index);
          if (tc.id)                   entry.id   += tc.id;
          if (tc.function?.name)       entry.name += tc.function.name;
          if (tc.function?.arguments)  entry.args += tc.function.arguments;
          // Announce when we first learn the name
          if (tc.function?.name && entry.name === tc.function.name) {
            onChunk({ type: 'tool_start', id: entry.id, name: entry.name });
          }
        }
      }

      // ── Per-choice usage (some endpoints include it here) ─────────────────
      if (data.usage) {
        inputTokens  = data.usage.prompt_tokens     ?? inputTokens;
        outputTokens = data.usage.completion_tokens ?? outputTokens;
        onChunk({ type: 'stats', inputTokens, outputTokens });
      }
    },

    onEnd: () => {
      const rawText     = accText.join('');
      const rawReasoning = accReason.join('') || null;

      // Post-process accumulated text to extract reasoning in any supported format:
      //   • Qwen3  <|channel|>analysis<|message|>…<|channel|>final<|message|>…
      //   • DeepSeek / QwQ  <think>…</think>
      // Skip if we already received reasoning via a dedicated delta field.
      let finalText      = rawText;
      let finalReasoning = rawReasoning;
      if (!finalReasoning) {
        const extracted  = extractReasoningAndText(rawText);
        finalText        = extracted.text;
        finalReasoning   = extracted.reasoning;
      }

      // Completed tool calls
      const toolUse = toolMap.size > 0
        ? [...toolMap.values()].map(tc => ({
            id:    tc.id,
            name:  tc.name,
            input: (() => { try { return JSON.parse(tc.args); } catch { return {}; } })(),
          }))
        : null;

      if (toolUse?.length) {
        for (const tc of toolUse) {
          onChunk({ type: 'tool_done', id: tc.id, name: tc.name, input: tc.input });
        }
      }

      onChunk({ type: 'done' });

      // Reconstruct rawContent in OpenAI message shape
      const rawContent = toolUse?.length
        ? {
            role:       'assistant',
            content:    finalText ?? null,
            tool_calls: [...toolMap.values()].map(tc => ({
              id:       tc.id,
              type:     'function',
              function: { name: tc.name, arguments: tc.args },
            })),
          }
        : { role: 'assistant', content: finalText };

      resolve({
        text:       finalText || (toolUse?.length ? null : '[no response]'),
        toolUse,
        rawContent,
        mode,
        reasoning:  finalReasoning,
        stats:      { inputTokens, outputTokens },
        responseId: null,
      });
    },

    onError: (err) => {
      onChunk({ type: 'error', message: err.message });
      reject(err);
    },
  });
}

function streamAnthropic(request, onChunk, resolve, reject) {
  const blocks = new Map();     // index → { type, content, id, name }
  let inputTokens  = null;
  let outputTokens = null;

  httpStream(request.url, request.headers, request.body, {
    onEvent: (eventType, data) => {
      switch (eventType) {
        case 'message_start':
          inputTokens = data.message?.usage?.input_tokens ?? null;
          break;

        case 'content_block_start': {
          const cb    = data.content_block ?? {};
          const block = { type: cb.type, content: '', id: cb.id ?? null, name: cb.name ?? null };
          blocks.set(data.index, block);
          if (cb.type === 'tool_use') {
            onChunk({ type: 'tool_start', id: cb.id, name: cb.name });
          }
          break;
        }

        case 'content_block_delta': {
          const block = blocks.get(data.index);
          if (!block) break;
          const d = data.delta ?? {};
          if (d.type === 'text_delta') {
            block.content += d.text;
            onChunk({ type: 'text', delta: d.text });
          } else if (d.type === 'thinking_delta') {
            block.content += d.thinking;
            onChunk({ type: 'reasoning', delta: d.thinking });
          } else if (d.type === 'input_json_delta') {
            block.content += d.partial_json;
          }
          break;
        }

        case 'content_block_stop': {
          const block = blocks.get(data.index);
          if (block?.type === 'tool_use') {
            let input = {};
            try { input = JSON.parse(block.content); } catch { /* keep empty */ }
            onChunk({ type: 'tool_done', id: block.id, name: block.name, input });
          }
          break;
        }

        case 'message_delta':
          if (data.usage?.output_tokens != null) {
            outputTokens = data.usage.output_tokens;
            onChunk({ type: 'stats', inputTokens, outputTokens });
          }
          break;

        default: break;
      }
    },

    onEnd: () => {
      // Reconstruct full content array
      const content = [];
      const textParts = [], thinkParts = [], toolUse = [];

      for (const [idx, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.content });
          textParts.push(block.content);
        } else if (block.type === 'thinking') {
          content.push({ type: 'thinking', thinking: block.content });
          thinkParts.push(block.content);
        } else if (block.type === 'tool_use') {
          let input = {};
          try { input = JSON.parse(block.content); } catch {}
          content.push({ type: 'tool_use', id: block.id, name: block.name, input });
          toolUse.push({ id: block.id, name: block.name, input });
        }
      }

      const text      = textParts.join('')  || null;
      const reasoning = thinkParts.join('') || null;

      onChunk({ type: 'done' });

      resolve({
        text:       text ?? (toolUse.length ? null : '[no response]'),
        toolUse:    toolUse.length ? toolUse : null,
        rawContent: content,
        mode:       'anthropic',
        reasoning,
        stats:      { inputTokens, outputTokens },
        responseId: null,
      });
    },

    onError: (err) => {
      onChunk({ type: 'error', message: err.message });
      reject(err);
    },
  });
}

// LM Studio v1 streaming — documented event format:
//   message.delta   → data.content  (text token)
//   reasoning.delta → data.content  (reasoning token)
//   tool_call.start → data.tool     (server-side tool name, informational)
//   chat.end        → data.result   (full non-streaming response object)
//   error           → data.error    (partial error, stream continues to chat.end)
// All other events (chat.start, model_load.*, prompt_processing.*, *.start, *.end,
// tool_call.arguments/success/failure) are silently ignored.

function streamLMStudioV1(request, onChunk, resolve, reject) {
  let resolved = false;

  httpStream(request.url, request.headers, request.body, {
    onEvent: (_eventType, data) => {
      // data.type is the canonical event identifier (mirrors SSE event: field)
      switch (data.type) {

        case 'message.delta':
          if (data.content) onChunk({ type: 'text', delta: data.content });
          break;

        case 'reasoning.delta':
          if (data.content) onChunk({ type: 'reasoning', delta: data.content });
          break;

        case 'tool_call.start':
          // LM Studio executes these server-side — just show progress to the user
          if (data.tool) onChunk({ type: 'tool_start', id: null, name: data.tool });
          break;

        case 'chat.end': {
          if (resolved) break;
          const fullResponse = data.result;
          if (!fullResponse) break;
          resolved = true;
          const parsed = parseLMStudioV1Response(fullResponse);
          if (parsed.stats?.inputTokens != null || parsed.stats?.outputTokens != null) {
            onChunk({ type: 'stats',
              inputTokens:  parsed.stats.inputTokens,
              outputTokens: parsed.stats.outputTokens,
              extra:        parsed.stats,
            });
          }
          if (parsed.responseId) onChunk({ type: 'response_id', id: parsed.responseId });
          onChunk({ type: 'done' });
          resolve(parsed);
          break;
        }

        case 'error':
          // Non-fatal stream error — LM Studio still sends chat.end afterwards
          console.warn('[llm:stream:v1]', data.error?.message ?? 'stream error');
          break;

        // chat.start, model_load.*, prompt_processing.*, reasoning.start/end,
        // message.start/end, tool_call.arguments/success/failure → no-op
        default: break;
      }
    },

    onEnd: () => {
      // chat.end fires before [DONE] and resolves the promise above.
      // If we get here without resolving (malformed stream), return a fallback.
      if (resolved) return;
      onChunk({ type: 'done' });
      resolve({
        text:            '[stream ended without response]',
        toolUse:         null,
        rawContent:      [],
        mode:            'lmstudio-v1',
        reasoning:       null,
        stats:           { inputTokens: null, outputTokens: null },
        responseId:      null,
        serverToolCalls: null,
      });
    },

    onError: (err) => {
      onChunk({ type: 'error', message: err.message });
      reject(err);
    },
  });
}

// ─── Response parsers ─────────────────────────────────────────────────────────
//
// All parsers now return a unified object:
// {
//   text:       string | null,        — final text (null if tool_use stop)
//   toolUse:    Array  | null,        — [{id, name, input}] if tool_use / tool_calls
//   rawContent: any,                  — raw content block for history (mode-specific)
//   mode:       string,
//   reasoning:  string | null,        — extracted thinking/reasoning text
//   stats:      object | null,        — LM Studio v1 only
//   responseId: string | null,        — LM Studio v1 only
// }

function parseAnthropicResponse(data) {
  const content = data.content ?? [];

  // Extract extended-thinking blocks (present when thinking beta is enabled)
  const thinkingText = content
    .filter(b => b.type === 'thinking')
    .map(b => b.thinking || '')
    .join('\n').trim() || null;

  // Token usage — Anthropic always includes this in the response
  const usage = {
    inputTokens:  data.usage?.input_tokens  ?? null,
    outputTokens: data.usage?.output_tokens ?? null,
  };

  if (data.stop_reason === 'tool_use') {
    const toolUse = content
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));
    const textBlock = content.find(b => b.type === 'text');
    return {
      text:       textBlock?.text ?? null,
      toolUse,
      rawContent: content,   // full content array — pushed as assistant message content
      mode:       'anthropic',
      reasoning:  thinkingText,
      stats:      usage,
      responseId: null,
    };
  }

  return {
    text:       content.find(b => b.type === 'text')?.text ?? '[no response]',
    toolUse:    null,
    rawContent: content,
    mode:       'anthropic',
    reasoning:  thinkingText,
    stats:      usage,
    responseId: null,
  };
}

// Extracts <think>...</think> blocks emitted by many open-source reasoning
// models (DeepSeek R1, QwQ, etc.) via OpenAI-compatible endpoints.
// Returns { text: remaining content, reasoning: extracted block or null }.
function extractThinkTags(raw) {
  if (!raw) return { text: raw, reasoning: null };
  // Allow leading whitespace before the opening tag
  const match = raw.match(/^\s*<think>([\s\S]*?)<\/think>\s*/i);
  if (!match) return { text: raw, reasoning: null };
  return {
    text:      raw.slice(match[0].length).trim() || '[no response]',
    reasoning: match[1].trim() || null,
  };
}

// Extracts Qwen3's multi-channel thinking format:
//   <|channel|>analysis<|message|>REASONING<|end|><|start|>assistant<|channel|>final<|message|>TEXT
//
// The 'analysis' channel maps to reasoning; the 'final' channel maps to the
// response text.  Returns null if the input doesn't look like this format so
// the caller can fall through to other extractors.
function extractQwenChannels(raw) {
  if (!raw || !raw.includes('<|channel|>')) return null;

  const channels = {};
  // Each channel block ends at <|end|>, <|start|>, or end of string
  const re = /<\|channel\|>(\w+)<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|start\|>|$)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    channels[m[1]] = m[2].trim();
  }

  // Require at least a 'final' (or 'response') channel to confirm the format.
  // Without it we might misparse something that just happens to contain the token.
  if (!('final' in channels) && !('response' in channels)) return null;

  const text      = (channels.final    ?? channels.response ?? '').trim() || '[no response]';
  const reasoning = (channels.analysis ?? channels.thinking ?? '').trim() || null;
  return { text, reasoning };
}

// Unified reasoning/text extractor for OpenAI-compat responses.
// Priority:  1. Qwen3 <|channel|> format
//            2. DeepSeek / QwQ <think>...</think> tags
//            3. Raw string as-is (no reasoning)
function extractReasoningAndText(raw) {
  const qwen = extractQwenChannels(raw);
  if (qwen) return qwen;
  return extractThinkTags(raw ?? '[no response]');
}

function parseOpenAIResponse(data, mode) {
  const choice = data.choices?.[0];
  const msg    = choice?.message;
  if (!msg) {
    return { text: '[no response]', toolUse: null, rawContent: null, mode, reasoning: null, stats: null, responseId: null };
  }

  // Token usage — OpenAI uses prompt_tokens / completion_tokens
  const usage = {
    inputTokens:  data.usage?.prompt_tokens     ?? null,
    outputTokens: data.usage?.completion_tokens ?? null,
  };

  if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
    const toolUse = msg.tool_calls.map(tc => ({
      id:    tc.id,
      name:  tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
    }));
    const { reasoning } = extractReasoningAndText(msg.content ?? '');
    return {
      text:       msg.content ?? null,
      toolUse,
      rawContent: msg,   // full message object — pushed as assistant turn
      mode,
      reasoning,
      stats:      usage,
      responseId: null,
    };
  }

  // Many open-source reasoning models prefix their response with a reasoning
  // block — either <think>…</think> (DeepSeek/QwQ) or Qwen3's multi-channel
  // <|channel|>analysis<|message|>…<|channel|>final<|message|>… format.
  const { text, reasoning } = extractReasoningAndText(msg.content ?? '[no response]');
  return {
    text,
    toolUse:    null,
    rawContent: msg,
    mode,
    reasoning,
    stats:      usage,
    responseId: null,
  };
}

// LM Studio v1 response parser.
//
// The `output` array can contain multiple typed items:
//   { type: "message",          content }         — text response
//   { type: "reasoning",        content }         — reasoning/thinking block
//   { type: "tool_call",        tool, arguments, output, provider_info }
//   { type: "invalid_tool_call", reason, metadata }
//
// Tool calls are executed server-side by LM Studio via `integrations`
// (ephemeral MCP / plugins) — the client does not need to run a tool loop.
// We surface them as `serverToolCalls` for display purposes.
// The final response text is the LAST message block (tools may precede it).

function parseLMStudioV1Response(data) {
  const outputs    = Array.isArray(data.output) ? data.output : [];

  // Use the last message block — tool calls may fire before the final answer
  const msgBlocks  = outputs.filter(o => o.type === 'message');
  const msgBlock   = msgBlocks[msgBlocks.length - 1] ?? null;

  const thinkBlock = outputs.find(o => o.type === 'reasoning' || o.type === 'thinking');

  // Server-side tool calls (LM Studio executed these via integrations).
  // The client doesn't execute them but we preserve them for display / logging.
  const toolCallBlocks = outputs.filter(o => o.type === 'tool_call');

  // Merge LM Studio performance stats (tok/s, TTFT) with token usage counts.
  // Priority: data.usage fields → data.stats fields (input_tokens, total_output_tokens)
  //           → legacy fallbacks (prompt_eval_count, tokens_generated)
  const perfStats = data.stats ?? {};
  const stats = {
    ...perfStats,
    inputTokens:  data.usage?.input_tokens  ?? data.usage?.prompt_tokens     ?? perfStats.input_tokens        ?? perfStats.prompt_eval_count  ?? null,
    outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? perfStats.total_output_tokens ?? perfStats.tokens_generated   ?? null,
  };

  return {
    text:            msgBlock?.content   ?? '[no response]',
    toolUse:         null,                                   // no client-side loop needed
    rawContent:      outputs,                                // full output array for reference
    mode:            'lmstudio-v1',
    reasoning:       thinkBlock?.content ?? null,
    stats,
    responseId:      data.response_id   ?? null,
    serverToolCalls: toolCallBlocks.length ? toolCallBlocks : null,
  };
}

// ─── Models URL helper ────────────────────────────────────────────────────────

function getModelsUrl(endpoint) {
  const parsed = new URL(endpoint);
  const base = `${parsed.protocol}//${parsed.host}`;
  if (endpoint.includes('/api/v0/') || endpoint.includes('/api/v1/')) {
    return `${base}/api/v0/models`;  // model list is still on v0
  }
  return `${base}/v1/models`;
}

// ─── complete ─────────────────────────────────────────────────────────────────
// args: { endpoint, model, systemPrompt, apiKey, messages,
//         previousResponseId?, store?, tools? }
//
// tools — array of Anthropic-format tool schemas (optional).
//         buildOpenAIRequest converts to OpenAI format internally.
//         lmstudio-v1 does not use the `tools` field — tool use is configured
//         server-side via `integrations` in LM Studio itself.
//
// Always returns a unified object — see parser docs above.

async function complete({ endpoint, model, systemPrompt, apiKey, messages, previousResponseId, store, tools, integrations }) {
  if (!endpoint)         throw new Error('No endpoint configured for this persona.');
  if (!messages?.length) throw new Error('No messages to send.');

  const mode = detectMode(endpoint);

  let request;
  if (mode === 'anthropic') {
    request = buildAnthropicRequest(endpoint, { model, systemPrompt, apiKey, messages, tools });
  } else if (mode === 'lmstudio-v1') {
    request = buildLMStudioV1Request(endpoint, { model, systemPrompt, apiKey, messages, previousResponseId, store, integrations });
  } else {
    request = buildOpenAIRequest(endpoint, { model, systemPrompt, apiKey, messages, tools });
  }

  // ── Debug logging ────────────────────────────────────────────────────────────
  console.log(`\n[llm] ▶ mode=${mode}  model=${model}  endpoint=${request.url}`);
  console.log('[llm] REQUEST:', JSON.stringify(request.body, null, 2));

  const data = await fetchJson(request.url, request.headers, request.body);

  console.log('[llm] RESPONSE:', JSON.stringify(data, null, 2));
  // ─────────────────────────────────────────────────────────────────────────────

  if (mode === 'anthropic')   return parseAnthropicResponse(data);
  if (mode === 'lmstudio-v1') return parseLMStudioV1Response(data);
  return parseOpenAIResponse(data, mode);
}

// ─── stream ───────────────────────────────────────────────────────────────────
// Same args as complete(), plus onChunk callback for incremental events.
// Returns a Promise that resolves with the unified result when the stream ends.
// onChunk is called with normalised chunk objects (see streaming parsers above).

async function stream({ endpoint, model, systemPrompt, apiKey, messages, previousResponseId, store, tools, integrations }, onChunk) {
  if (!endpoint)         throw new Error('No endpoint configured for this persona.');
  if (!messages?.length) throw new Error('No messages to send.');

  const mode = detectMode(endpoint);

  let request;
  if (mode === 'anthropic') {
    request = buildAnthropicRequest(endpoint, { model, systemPrompt, apiKey, messages, tools });
    request.body.stream = true;
  } else if (mode === 'lmstudio-v1') {
    request = buildLMStudioV1Request(endpoint, { model, systemPrompt, apiKey, messages, previousResponseId, store, integrations });
    request.body.stream = true;
  } else {
    request = buildOpenAIRequest(endpoint, { model, systemPrompt, apiKey, messages, tools });
    request.body.stream = true;
  }

  console.log(`\n[llm:stream] ▶ mode=${mode}  model=${model}  endpoint=${request.url}`);
  console.log('[llm:stream] REQUEST:', JSON.stringify(request.body, null, 2));

  return new Promise((resolve, reject) => {
    if (mode === 'anthropic') {
      streamAnthropic(request, onChunk, resolve, reject);
    } else if (mode === 'lmstudio-v1') {
      streamLMStudioV1(request, onChunk, resolve, reject);
    } else {
      streamOpenAI(request, onChunk, resolve, reject, mode);
    }
  });
}

// ─── fetchModels ──────────────────────────────────────────────────────────────
// args: { endpoint, apiKey }
// Queries the model list endpoint (LM Studio /api/v0/models or OpenAI /v1/models).
// Returns [{ id, state, type, quantization, maxContext, arch }] — embedding models excluded.

async function fetchModels({ endpoint, apiKey }) {
  if (!endpoint) throw new Error('No endpoint configured.');

  const modelsUrl = getModelsUrl(endpoint);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const data = await fetchJsonGet(modelsUrl, headers);
  const raw  = Array.isArray(data) ? data : (data.data || []);

  return raw
    .filter(m => !m.type || m.type === 'llm' || m.type === 'vlm')
    .map(m => ({
      id:           m.id,
      state:        m.state             || 'unknown',
      type:         m.type              || 'llm',
      quantization: m.quantization      || null,
      maxContext:   m.max_context_length || null,
      arch:         m.arch              || null,
    }));
}

module.exports = { complete, stream, fetchModels };
