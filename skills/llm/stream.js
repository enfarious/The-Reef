'use strict';

const { detectMode }          = require('./detect-mode');
const { buildAnthropicRequest, buildOpenAIRequest, buildLMStudioV1Request } = require('./request-builders');
const { streamOpenAI, streamAnthropic, streamLMStudioV1 } = require('./stream-parsers');

// ─── stream ───────────────────────────────────────────────────────────────────
// Same args as complete(), plus onChunk callback for incremental events.
// Returns a Promise that resolves with the unified result when the stream ends.
// onChunk is called with normalised chunk objects (see streaming parsers above).

async function stream({ endpoint, model, systemPrompt, apiKey, messages, previousResponseId, store, tools, integrations }, onChunk) {
  if (!endpoint)                    throw new Error('No endpoint configured for this persona.');
  if (endpoint === 'claude-cli')   throw new Error('Claude CLI proxy is not ready. Run "claude login" and restart the app.');
  if (!messages?.length)           throw new Error('No messages to send.');

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

  // The returned Promise has an extra .abort(reason) method that immediately
  // destroys the TCP socket so the STOP button feels instant.
  let _req = null;
  const promise = new Promise((resolve, reject) => {
    const onRequest = (r) => { _req = r; };
    if (mode === 'anthropic') {
      streamAnthropic(request, onChunk, resolve, reject, onRequest);
    } else if (mode === 'lmstudio-v1') {
      streamLMStudioV1(request, onChunk, resolve, reject, onRequest);
    } else {
      streamOpenAI(request, onChunk, resolve, reject, mode, onRequest);
    }
  });

  promise.abort = (reason = 'aborted') => {
    if (_req && !_req.destroyed) _req.destroy(new Error(reason));
  };
  promise.getMode = () => mode;

  return promise;
}

module.exports = stream;
