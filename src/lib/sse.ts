/** Server-Sent Events parsing for streaming LLM responses. */
export interface SSEEvent {
  event?: string;
  data: string;
}

/** Incremental parser: feed text chunks, get complete events back. */
export function createSSEParser() {
  let buffer = '';

  function parseBlock(block: string): SSEEvent | null {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
    if (!data.length) return null;
    return { event, data: data.join('\n') };
  }

  function drain(final: boolean): SSEEvent[] {
    // Normalize CRLF / CR line endings, but keep a trailing CR until we know
    // whether the next chunk starts with LF.
    const keepCR = !final && buffer.endsWith('\r');
    const body = keepCR ? buffer.slice(0, -1) : buffer;
    let text = body.replace(/\r\n?/g, '\n');
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = text.indexOf('\n\n')) !== -1) {
      const ev = parseBlock(text.slice(0, idx));
      if (ev) events.push(ev);
      text = text.slice(idx + 2);
    }
    if (final && text.trim()) {
      const ev = parseBlock(text);
      if (ev) events.push(ev);
      text = '';
    }
    buffer = text + (keepCR ? '\r' : '');
    return events;
  }

  return {
    push(chunk: string): SSEEvent[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): SSEEvent[] {
      return drain(true);
    },
  };
}

export async function* readSSE(res: Response): AsyncGenerator<SSEEvent> {
  if (!res.body) throw new Error('Response has no body to stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.push(decoder.decode())) yield ev;
    for (const ev of parser.flush()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
