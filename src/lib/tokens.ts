import type { ChatMessage, TokenUsage } from '../state/types';

/**
 * Rough token estimate (~4 characters per token for English text). Used only
 * when a provider does not report usage; results are flagged as estimates.
 * Use Tools → Tokenizer for exact counts with a specific tokenizer.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateUsage(system: string | undefined, messages: ChatMessage[], output: string): TokenUsage {
  const input = estimateTokens(system ?? '') + messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
  return { inputTokens: input, outputTokens: estimateTokens(output), estimated: true };
}
