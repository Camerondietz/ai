/**
 * In-memory handoff between pages (e.g. "Open in chat" from the prompt
 * library). Content is never put in the URL, so it can't leak via history,
 * bookmarks or screen shares of the address bar.
 */
export interface ChatHandoff {
  system?: string;
  input?: string;
  providerId?: string;
  model?: string;
}

let pending: ChatHandoff | null = null;

export function setChatHandoff(h: ChatHandoff) {
  pending = h;
}

export function takeChatHandoff(): ChatHandoff | null {
  const h = pending;
  // Cleared shortly after, not immediately, so React StrictMode's double
  // effect invocation in development sees the same handoff twice.
  if (h) {
    setTimeout(() => {
      if (pending === h) pending = null;
    }, 1000);
  }
  return h;
}
