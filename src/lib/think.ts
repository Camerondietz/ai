/**
 * Some small reasoning models (e.g. Qwen3) wrap their reasoning in
 * <think>…</think> inside the normal text stream. These helpers separate it.
 */
const OPEN = '<think>';
const CLOSE = '</think>';

/** Streaming splitter: returns a function to feed chunks into. */
export function createThinkSplitter(onText?: (t: string) => void, onThinking?: (t: string) => void) {
  let mode: 'detect' | 'think' | 'text' = 'detect';
  let buf = '';
  return (chunk: string) => {
    if (mode === 'text') {
      onText?.(chunk);
      return;
    }
    buf += chunk;
    if (mode === 'detect') {
      const t = buf.trimStart();
      if (t.startsWith(OPEN)) {
        mode = 'think';
        buf = t.slice(OPEN.length);
      } else if (OPEN.startsWith(t)) {
        return; // may still become "<think>"
      } else {
        mode = 'text';
        onText?.(buf);
        buf = '';
        return;
      }
    }
    const end = buf.indexOf(CLOSE);
    if (end === -1) {
      // Hold back enough characters to catch a closing tag split across chunks.
      const safe = buf.length - CLOSE.length;
      if (safe > 0) {
        onThinking?.(buf.slice(0, safe));
        buf = buf.slice(safe);
      }
      return;
    }
    if (end > 0) onThinking?.(buf.slice(0, end));
    const rest = buf.slice(end + CLOSE.length).replace(/^\s+/, '');
    mode = 'text';
    buf = '';
    if (rest) onText?.(rest);
  };
}

/** Split a complete response into visible content and reasoning. */
export function splitThink(text: string): { content: string; thinking?: string } {
  const m = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text);
  if (!m) return { content: text };
  return { content: text.slice(m[0].length), thinking: m[1].trim() || undefined };
}
