'use strict';

// ─── Response parsers ─────────────────────────────────────────────────────────
//
// All parsers return a unified object:
// {
//   text:       string | null,        — final text (null if tool_use stop)
//   toolUse:    Array  | null,        — [{id, name, input}] if tool_use / tool_calls
//   rawContent: any,                  — raw content block for history (mode-specific)
//   mode:       string,
//   reasoning:  string | null,        — extracted thinking/reasoning text
//   stats:      object | null,        — token usage
//   responseId: string | null,        — LM Studio v1 only
// }

// ─── Reasoning extractors ─────────────────────────────────────────────────────

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

// ─── Anthropic parser ─────────────────────────────────────────────────────────

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

// ─── OpenAI parser ────────────────────────────────────────────────────────────

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
  // block — either <think>...</think> (DeepSeek/QwQ) or Qwen3's multi-channel
  // <|channel|>analysis<|message|>...<|channel|>final<|message|>... format.
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

// ─── LM Studio v1 parser ─────────────────────────────────────────────────────
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
  // Priority: data.usage fields -> data.stats fields (input_tokens, total_output_tokens)
  //           -> legacy fallbacks (prompt_eval_count, tokens_generated)
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

module.exports = {
  extractThinkTags,
  extractQwenChannels,
  extractReasoningAndText,
  parseAnthropicResponse,
  parseOpenAIResponse,
  parseLMStudioV1Response,
};
