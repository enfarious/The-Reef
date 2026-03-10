// ─── Global LLM call concurrency ─────────────────────────────────────────────
// FIFO semaphore — prevents all entities hammering the LLM simultaneously.

export const MAX_LLM_CONCURRENT = 1;
let   llmActiveSlots  = 0;
const llmSlotWaiters  = [];

export const TOOL_CHAIN_YIELD_STEPS = 3;

export function acquireLlmSlot() {
  return new Promise(resolve => {
    llmSlotWaiters.push(resolve);
    _drainLlmSlots();
  });
}

export function releaseLlmSlot() {
  llmActiveSlots = Math.max(0, llmActiveSlots - 1);
  _drainLlmSlots();
}

function _drainLlmSlots() {
  while (llmSlotWaiters.length > 0 && llmActiveSlots < MAX_LLM_CONCURRENT) {
    llmActiveSlots++;
    llmSlotWaiters.shift()();
  }
}
