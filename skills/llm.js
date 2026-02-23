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
// - First turn:       { model, input }
// - Subsequent turns: { model, input, previous_response_id }
// - Ephemeral query:  { model, input, store: false }
//
// LM Studio v1 has strict key validation — it rejects unknown fields.
// There is no separate system/instructions field in this API version.
// On the first turn we fold the system prompt into `input` with a clear
// delimiter so the model sees it as context. Continuation turns omit it
// entirely because the server already holds the conversation context.
// Tools are not yet supported for lmstudio-v1 — ignored if passed.

function buildLMStudioV1Request(endpoint, { model, systemPrompt, apiKey, messages, previousResponseId, store }) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';

  // First turn: prepend system prompt so the persona's character is established
  const input = (systemPrompt && !previousResponseId)
    ? `${systemPrompt}\n\n${userText}`
    : userText;

  const body = { model, input };
  if (previousResponseId) body.previous_response_id = previousResponseId;
  if (store === false)    body.store = false;

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
      stats:      null,
      responseId: null,
    };
  }

  return {
    text:       content.find(b => b.type === 'text')?.text ?? '[no response]',
    toolUse:    null,
    rawContent: content,
    mode:       'anthropic',
    reasoning:  thinkingText,
    stats:      null,
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

function parseOpenAIResponse(data, mode) {
  const choice = data.choices?.[0];
  const msg    = choice?.message;
  if (!msg) {
    return { text: '[no response]', toolUse: null, rawContent: null, mode, reasoning: null, stats: null, responseId: null };
  }

  if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
    const toolUse = msg.tool_calls.map(tc => ({
      id:    tc.id,
      name:  tc.function.name,
      input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
    }));
    const { reasoning } = extractThinkTags(msg.content ?? '');
    return {
      text:       msg.content ?? null,
      toolUse,
      rawContent: msg,   // full message object — pushed as assistant turn
      mode,
      reasoning,
      stats:      null,
      responseId: null,
    };
  }

  // Many open-source reasoning models (DeepSeek R1, QwQ, etc.) prefix their
  // response with <think>...</think> when served via OpenAI-compat endpoints.
  const { text, reasoning } = extractThinkTags(msg.content ?? '[no response]');
  return {
    text,
    toolUse:    null,
    rawContent: msg,
    mode,
    reasoning,
    stats:      null,
    responseId: null,
  };
}

// LM Studio v1 — tools not yet supported in this API version.
// Returns unified response object for consistency.
function parseLMStudioV1Response(data) {
  const outputs    = Array.isArray(data.output) ? data.output : [];
  const msgBlock   = outputs.find(o => o.type === 'message');
  const thinkBlock = outputs.find(o => o.type === 'reasoning' || o.type === 'thinking');
  const stats      = data.stats ?? null;

  return {
    text:       msgBlock?.content   ?? '[no response]',
    toolUse:    null,
    rawContent: null,
    mode:       'lmstudio-v1',
    reasoning:  thinkBlock?.content ?? null,
    stats,
    responseId: data.response_id   ?? null,
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
//         lmstudio-v1 ignores tools (not yet supported).
//
// Always returns a unified object — see parser docs above.

async function complete({ endpoint, model, systemPrompt, apiKey, messages, previousResponseId, store, tools }) {
  if (!endpoint)         throw new Error('No endpoint configured for this persona.');
  if (!messages?.length) throw new Error('No messages to send.');

  const mode = detectMode(endpoint);

  let request;
  if (mode === 'anthropic') {
    request = buildAnthropicRequest(endpoint, { model, systemPrompt, apiKey, messages, tools });
  } else if (mode === 'lmstudio-v1') {
    request = buildLMStudioV1Request(endpoint, { model, systemPrompt, apiKey, messages, previousResponseId, store });
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

module.exports = { complete, fetchModels };
