import type { ChatMessage, ChatParams, ProviderConfig, TokenUsage } from '../state/types';

export interface ChatRequest {
  provider: ProviderConfig;
  apiKey?: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  params: ChatParams;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  /** Non-content status updates, e.g. local model download progress */
  onStatus?: (status: string) => void;
}

export interface ChatResult {
  text: string;
  thinking?: string;
  usage?: TokenUsage;
  stopReason?: string;
  model: string;
  firstTokenMs?: number;
  /** Request body as sent (never includes credentials) */
  request?: unknown;
  /** Response metadata as received */
  response?: unknown;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** Build a readable error from a failed HTTP response (reads at most ~4 KB). */
export async function httpError(res: Response): Promise<ProviderHttpError> {
  let detail = res.statusText;
  try {
    const text = (await res.text()).slice(0, 4000);
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string; detail?: unknown };
      if (typeof json.error === 'string') detail = json.error;
      else if (json.error?.message) detail = json.error.message;
      else if (json.message) detail = json.message;
      else if (json.detail) detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail);
      else detail = text;
    } catch {
      if (text) detail = text;
    }
  } catch {
    // body unreadable
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ' — check the API key / token permissions.'
      : res.status === 404
        ? ' — check the base URL and model id.'
        : res.status === 429
          ? ' — rate limited; slow down or check your quota.'
          : '';
  return new ProviderHttpError(res.status, `HTTP ${res.status}: ${detail}${hint}`);
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
