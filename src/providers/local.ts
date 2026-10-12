/** In-browser chat via Transformers.js running in the inference worker. */
import { formatBytes } from '../lib/format';
import { createThinkSplitter, splitThink } from '../lib/think';
import { getSettings } from '../state/settings';
import { interruptGeneration, runModel } from '../workers/mlClient';
import type { ChatRequest, ChatResult } from './types';

export async function chatLocal(req: ChatRequest): Promise<ChatResult> {
  const messages = [
    ...(req.system ? [{ role: 'system', content: req.system }] : []),
    ...req.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const options: Record<string, unknown> = { max_new_tokens: req.params.maxTokens ?? 1024 };
  if (req.params.temperature != null && req.params.temperature > 0) {
    options.do_sample = true;
    options.temperature = req.params.temperature;
    if (req.params.topP != null) options.top_p = req.params.topP;
  }

  const onAbort = () => interruptGeneration();
  req.signal?.addEventListener('abort', onAbort);
  const started = performance.now();
  let firstTokenMs: number | undefined;
  const split = createThinkSplitter(
    (t) => {
      firstTokenMs ??= performance.now() - started;
      req.onDelta?.(t);
    },
    (t) => req.onThinking?.(t),
  );
  const files = new Map<string, { loaded: number; total: number }>();

  try {
    const spec = { task: 'text-generation', model: req.model, device: getSettings().local.device, dtype: 'q4' };
    const { data, device } = await runModel<string>(spec, messages, options, {
      onToken: split,
      onProgress: (e) => {
        if (e.status === 'progress' && e.file && e.total) {
          files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          req.onStatus?.(`Downloading model ${formatBytes(loaded)} / ${formatBytes(total)}`);
        } else if (e.status === 'ready') {
          req.onStatus?.('Model loaded, generating…');
        }
      },
    });
    const { content, thinking } = splitThink(data);
    return {
      text: content,
      thinking,
      model: req.model,
      firstTokenMs,
      stopReason: req.signal?.aborted ? 'aborted' : 'end_turn',
      request: { model: req.model, messages, options, runtime: 'transformers.js' },
      response: { device },
    };
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
  }
}
