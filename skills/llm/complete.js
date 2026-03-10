'use strict';

const { detectMode }          = require('./detect-mode');
const { fetchJson }           = require('./http');
const { sanitizeResponse }    = require('./sanitize');
const { buildAnthropicRequest, buildOpenAIRequest, buildLMStudioV1Request } = require('./request-builders');
const { parseAnthropicResponse, parseOpenAIResponse, parseLMStudioV1Response } = require('./parsers');

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
  if (!endpoint)                    throw new Error('No endpoint configured for this persona.');
  if (endpoint === 'claude-cli')   throw new Error('Claude CLI proxy is not ready. Run "claude login" and restart the app.');
  if (!messages?.length)           throw new Error('No messages to send.');

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

  let data = await fetchJson(request.url, request.headers, request.body);

  console.log('[llm] RESPONSE:', JSON.stringify(data, null, 2));
  // ─────────────────────────────────────────────────────────────────────────────

  data = sanitizeResponse(data, mode);

  if (mode === 'anthropic')   return parseAnthropicResponse(data);
  if (mode === 'lmstudio-v1') return parseLMStudioV1Response(data);
  return parseOpenAIResponse(data, mode);
}

module.exports = complete;
