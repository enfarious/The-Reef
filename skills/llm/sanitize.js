'use strict';

// ─── Response sanitizer ─────────────────────────────────────────────────────
// Small models frequently corrupt tool call JSON by appending extra text after
// the closing brace, or by wrapping args in markdown fences.  This runs before
// any parser sees the raw response body and attempts lightweight repairs.
//
// Repairs attempted (in order):
//   1. Strip ```json … ``` / ``` … ``` fences wrapping the entire body
//   2. For OpenAI tool_calls: extract the first valid JSON object from
//      arguments strings that have trailing garbage after the closing }
//   3. Truncate assistant content strings that bleed into the next JSON key
//      (e.g. "content": "hello\n\nworking_memory_write[ARGS]{…}")

function sanitizeToolCallArgs(argsStr) {
  if (!argsStr || typeof argsStr !== 'string') return argsStr;
  const s = argsStr.trim();
  // Strip markdown fences
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenced) return fenced[1].trim();
  // Find the first top-level { … } and discard anything after it
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc)          { esc = false; continue; }
    if (c === '\\')   { esc = true;  continue; }
    if (c === '"')    { inStr = !inStr; continue; }
    if (inStr)        continue;
    if (c === '{')    { depth++; continue; }
    if (c === '}')    { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end !== -1 && end < s.length - 1) {
    console.warn('[llm:sanitize] Truncated trailing garbage after tool args JSON');
    return s.slice(0, end + 1);
  }
  return s;
}

function sanitizeResponse(data, mode) {
  if (!data || typeof data !== 'object') return data;
  try {
    if (mode === 'anthropic') {
      // Anthropic: tool_use blocks have an `input` object — already parsed, nothing to do
      return data;
    }
    // OpenAI / LM Studio: tool_calls[].function.arguments is a JSON string
    const choices = data.choices;
    if (!Array.isArray(choices)) return data;
    for (const choice of choices) {
      const tcs = choice?.message?.tool_calls;
      if (!Array.isArray(tcs)) continue;
      for (const tc of tcs) {
        if (tc?.function?.arguments) {
          tc.function.arguments = sanitizeToolCallArgs(tc.function.arguments);
        }
      }
    }
  } catch (e) {
    console.warn('[llm:sanitize] sanitizeResponse failed:', e.message);
  }
  return data;
}

module.exports = { sanitizeToolCallArgs, sanitizeResponse };
