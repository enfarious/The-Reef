'use strict';

const { httpStream }              = require('./http');
const { extractReasoningAndText, parseLMStudioV1Response } = require('./parsers');

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

function streamOpenAI(request, onChunk, resolve, reject, mode, onRequest) {
  const accText  = [];
  const accReason = [];
  // tool_calls indexed by tc.index
  const toolMap  = new Map();   // index -> { id, name, args }
  let inputTokens  = null;
  let outputTokens = null;

  const req = httpStream(request.url, request.headers, request.body, {
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
      //   * Qwen3  <|channel|>analysis<|message|>...<|channel|>final<|message|>...
      //   * DeepSeek / QwQ  <think>...</think>
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
  if (onRequest) onRequest(req);
}

function streamAnthropic(request, onChunk, resolve, reject, onRequest) {
  const blocks = new Map();     // index -> { type, content, id, name }
  let inputTokens  = null;
  let outputTokens = null;

  const req = httpStream(request.url, request.headers, request.body, {
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

      const text      = textParts.filter(t => t.trim()).join('\n\n') || null;
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
  if (onRequest) onRequest(req);
}

// LM Studio v1 streaming — documented event format:
//   message.delta   -> data.content  (text token)
//   reasoning.delta -> data.content  (reasoning token)
//   tool_call.start -> data.tool     (server-side tool name, informational)
//   chat.end        -> data.result   (full non-streaming response object)
//   error           -> data.error    (partial error, stream continues to chat.end)
// All other events (chat.start, model_load.*, prompt_processing.*, *.start, *.end,
// tool_call.arguments/success/failure) are silently ignored.

function streamLMStudioV1(request, onChunk, resolve, reject, onRequest) {
  let resolved = false;

  const req = httpStream(request.url, request.headers, request.body, {
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
        // message.start/end, tool_call.arguments/success/failure -> no-op
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
  if (onRequest) onRequest(req);
}

module.exports = { streamOpenAI, streamAnthropic, streamLMStudioV1 };
