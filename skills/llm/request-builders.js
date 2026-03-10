'use strict';

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

  // Convert Anthropic tool schemas -> OpenAI function-calling format
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

module.exports = { buildAnthropicRequest, buildOpenAIRequest, buildLMStudioV1Request };
