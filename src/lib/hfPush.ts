/**
 * Publish files (datasets, eval results, model cards) to the Hugging Face Hub
 * with the official @huggingface/hub client, loaded on demand. Repos are
 * created private unless the user explicitly chooses otherwise.
 */
import { HF_TOKEN_SECRET } from '../providers/presets';
import { getSettings } from '../state/settings';
import { getSecret } from '../state/vault';
import { makeFetch } from './net';

export interface PushOptions {
  repo: string;
  type: 'dataset' | 'model';
  private: boolean;
  files: { path: string; content: Blob }[];
  commitTitle: string;
  createIfMissing: boolean;
}

export async function pushToHub(opts: PushOptions): Promise<string> {
  const token = getSecret(HF_TOKEN_SECRET);
  if (!token) throw new Error('Add a Hugging Face token with write access in Settings → Hugging Face first.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('Repository must look like "username/name".');

  const hub = await import('@huggingface/hub');
  const fetchFn = makeFetch('huggingface-push');
  const hubUrl = getSettings().hf.endpoint.replace(/\/+$/, '');
  const repo = { type: opts.type, name: opts.repo };

  if (opts.createIfMissing) {
    try {
      await hub.createRepo({ repo, accessToken: token, private: opts.private, hubUrl, fetch: fetchFn });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = err instanceof Error ? err.message : String(err);
      if (status !== 409 && !/already exists|conflict/i.test(message)) throw err;
    }
  }

  await hub.uploadFiles({
    repo,
    accessToken: token,
    files: opts.files.map((f) => ({ path: f.path, content: f.content })),
    commitTitle: opts.commitTitle,
    hubUrl,
    fetch: fetchFn,
    useWebWorkers: false,
  });

  return `${hubUrl}/${opts.type === 'dataset' ? 'datasets/' : ''}${opts.repo}`;
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function datasetCard(opts: {
  name: string;
  description: string;
  columns: string[];
  rows: number;
  source?: string;
  license?: string;
  dataFile: string;
}): string {
  const sizeCategory =
    opts.rows < 1000 ? 'n<1K' : opts.rows < 10_000 ? '1K<n<10K' : opts.rows < 100_000 ? '10K<n<100K' : '100K<n<1M';
  return `---
license: ${opts.license ?? 'other'}
pretty_name: ${yamlString(opts.name)}
size_categories:
- ${sizeCategory}
configs:
- config_name: default
  data_files:
  - split: train
    path: ${yamlString(opts.dataFile)}
---

# ${opts.name}

${opts.description || '_No description provided._'}

## Structure

- Rows: ${opts.rows.toLocaleString()}
- Columns: ${opts.columns.map((c) => `\`${c}\``).join(', ')}
${opts.source ? `- Source: ${opts.source}\n` : ''}
_Published from AI Workbench._
`;
}

export function modelCard(opts: {
  name: string;
  description: string;
  baseModel?: string;
  params?: number;
  format?: string;
  tags: string[];
  notes?: string;
  license?: string;
}): string {
  const tags = opts.tags.length ? `tags:\n${opts.tags.map((t) => `- ${yamlString(t)}`).join('\n')}\n` : '';
  return `---
license: ${opts.license ?? 'other'}
${opts.baseModel ? `base_model: ${yamlString(opts.baseModel)}\n` : ''}${tags}---

# ${opts.name}

${opts.description || '_No description provided._'}

## Details

${opts.format ? `- Format: ${opts.format}\n` : ''}${opts.params ? `- Parameters: ${opts.params.toLocaleString()}\n` : ''}
${opts.notes ? `## Notes\n\n${opts.notes}\n` : ''}`;
}
