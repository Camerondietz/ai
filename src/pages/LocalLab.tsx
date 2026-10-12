import { useEffect, useMemo, useState } from 'react';
import { HBarList } from '../components/Charts';
import { JsonView } from '../components/JsonView';
import { Markdown } from '../components/Markdown';
import { Badge, Button, Card, Checkbox, Field, Input, KeyValues, Notice, PageHeader, Progress, Select, Textarea } from '../components/ui';
import { pickDirectory } from '../lib/download';
import { formatBytes, formatMs } from '../lib/format';
import { href, useRoute } from '../router';
import { updateSettings, useSettings } from '../state/settings';
import { toast, toastError } from '../state/toast';
import { clearModelCache, ensureReady, importModelFiles, interruptGeneration, loadModel, modelCacheInfo, runModel, terminateWorker } from '../workers/mlClient';
import { DTYPES, LOCAL_TASKS, type LocalDevice, type ProgressEvent } from '../workers/protocol';

async function decodeAudio(file: File): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const a = buf.getChannelData(0);
    const b = buf.getChannelData(1);
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
    return out;
  } finally {
    void ctx.close();
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function Environment({ onImported }: { onImported: (modelId: string) => void }) {
  const settings = useSettings();
  const [importing, setImporting] = useState(false);
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const [cache, setCache] = useState<{ files: number; bytes: number } | null>(null);

  const refreshCache = async () => {
    const info = await modelCacheInfo();
    setCache({ files: info.entries.length, bytes: info.bytes });
  };

  const importFolder = async () => {
    const files = await pickDirectory();
    if (!files.length) return;
    const folder = files[0].webkitRelativePath.split('/')[0] || 'model';
    setImporting(true);
    try {
      const r = await importModelFiles(files, folder);
      onImported(r.id);
      void refreshCache();
      toast(`Imported ${r.files} files (${formatBytes(r.bytes)}) as ${r.id}. Turn off Hugging Face downloads to keep it fully offline.`, 'success');
    } catch (err) {
      toastError(err, 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    ensureReady()
      .then((r) => setWebgpu(r.webgpu))
      .catch(() => setWebgpu(false));
    void refreshCache();
  }, []);

  return (
    <Card title="Runtime">
      <div className="stack">
        <KeyValues
          items={[
            ['WebGPU', webgpu == null ? 'checking…' : webgpu ? <Badge tone="ok">available</Badge> : <Badge tone="warn">not available (WebAssembly fallback)</Badge>],
            ['Threads', crossOriginIsolated ? 'multi-threaded' : 'single-threaded (host lacks cross-origin isolation headers)'],
            ['Model cache', cache ? `${cache.files} files · ${formatBytes(cache.bytes)}` : '—'],
            ['Remote models', settings.local.allowRemoteModels ? 'Hugging Face Hub (then cached locally)' : `Imported or self-hosted only (${settings.local.localModelPath})`],
          ]}
        />
        <div className="grid cols-2">
          <Field label="Device">
            <Select
              value={settings.local.device}
              onChange={(e) => updateSettings((s) => ({ ...s, local: { ...s.local, device: e.target.value as LocalDevice } }))}
            >
              <option value="auto">Auto (WebGPU if available)</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">WebAssembly (CPU)</option>
            </Select>
          </Field>
          <Field label=" ">
            <Checkbox
              checked={settings.local.allowRemoteModels}
              onChange={(v) => updateSettings((s) => ({ ...s, local: { ...s.local, allowRemoteModels: v } }))}
              label="Allow downloading models from Hugging Face"
            />
          </Field>
        </div>
        <div className="row">
          <Button size="sm" icon="upload" loading={importing} onClick={importFolder} title="Load a Transformers.js model folder (config.json, tokenizer, onnx/) from disk">
            Import model folder…
          </Button>
          <Button
            size="sm"
            icon="trash"
            onClick={async () => {
              if (!confirm('Delete all cached model weights (including imported models)? Downloaded ones will re-download on next use.')) return;
              await clearModelCache();
              await refreshCache();
              toast('Model cache cleared', 'success');
            }}
          >
            Clear model cache
          </Button>
          <Button
            size="sm"
            icon="stop"
            onClick={() => {
              terminateWorker();
              toast('Inference worker stopped; memory released.', 'info');
            }}
          >
            Unload all models
          </Button>
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refreshCache()}>
            Refresh
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function LocalLabPage() {
  const route = useRoute();
  const settings = useSettings();
  const initialTask = LOCAL_TASKS.find((t) => t.task === route.query.get('task'))?.task ?? 'text-generation';
  const [task, setTask] = useState(initialTask);
  const info = LOCAL_TASKS.find((t) => t.task === task)!;
  const [model, setModel] = useState(route.query.get('model') || info.defaultModel);
  const [dtype, setDtype] = useState<string>('auto');
  const [text, setText] = useState('');
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [labels, setLabels] = useState('urgent, billing, technical support, sales');
  const [context, setContext] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [optionsText, setOptionsText] = useState('');
  const [progress, setProgress] = useState<Record<string, { loaded: number; total: number }>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamed, setStreamed] = useState('');
  const [result, setResult] = useState<{ data: unknown; ms?: number; device?: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const m = route.query.get('model');
    if (m) setModel(m);
    const t = route.query.get('task');
    if (t && LOCAL_TASKS.some((x) => x.task === t)) setTask(t);
  }, [route.query]);

  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const spec = { task, model: model.trim(), device: settings.local.device, dtype: dtype === 'auto' ? undefined : dtype };

  const onProgress = (e: ProgressEvent) => {
    if (e.status === 'progress' && e.file && e.total) {
      setProgress((p) => ({ ...p, [e.file!]: { loaded: e.loaded ?? 0, total: e.total ?? 0 } }));
    }
    if (e.status === 'ready') setStatus('Model ready');
  };

  const load = async () => {
    setBusy(true);
    setError('');
    setProgress({});
    setStatus('Loading model…');
    try {
      const r = await loadModel(spec, onProgress);
      setStatus(`Loaded on ${r.device}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    let options: Record<string, unknown> | undefined;
    if (optionsText.trim()) {
      try {
        options = JSON.parse(optionsText) as Record<string, unknown>;
      } catch (err) {
        toastError(err, 'Options must be valid JSON');
        return;
      }
    }
    let input: unknown;
    switch (info.input) {
      case 'chat':
        input = [...(system.trim() ? [{ role: 'system', content: system }] : []), { role: 'user', content: text }];
        break;
      case 'text':
        input = task === 'feature-extraction' ? text.split('\n').map((l) => l.trim()).filter(Boolean) : text;
        break;
      case 'text-labels':
        input = { text, labels: labels.split(',').map((l) => l.trim()).filter(Boolean) };
        break;
      case 'qa':
        input = { question: text, context };
        break;
      case 'image':
        if (!file) return toast('Choose an image first', 'warning');
        input = file;
        break;
      case 'audio':
        if (!file) return toast('Choose an audio file first', 'warning');
        try {
          input = await decodeAudio(file);
        } catch (err) {
          toastError(err, 'Could not decode audio');
          return;
        }
        break;
      default:
        input = text;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setStreamed('');
    setProgress({});
    setStatus('Running…');
    try {
      let acc = '';
      const r = await runModel(spec, input, options, {
        onProgress,
        onToken: (t) => {
          acc += t;
          setStreamed(acc);
        },
      });
      setResult(r);
      setStatus(`Done in ${formatMs(r.ms)} on ${r.device}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const progressList = Object.entries(progress);
  const totalLoaded = progressList.reduce((s, [, p]) => s + p.loaded, 0);
  const totalSize = progressList.reduce((s, [, p]) => s + p.total, 0);

  return (
    <div className="page">
      <PageHeader
        title="Local Lab"
        description="Run Hugging Face models entirely on your device with Transformers.js. After the first download, inputs and outputs never leave the browser."
      />
      <div className="grid cols-3" style={{ alignItems: 'start' }}>
        <div className="stack" style={{ gridColumn: 'span 2' }}>
          <Card title="Model">
            <div className="stack">
              <div className="grid cols-3">
                <Field label="Task">
                  <Select
                    value={task}
                    onChange={(e) => {
                      const t = LOCAL_TASKS.find((x) => x.task === e.target.value)!;
                      setTask(t.task);
                      setModel(t.defaultModel);
                      setResult(null);
                      setStreamed('');
                      setFile(null);
                    }}
                  >
                    {LOCAL_TASKS.map((t) => (
                      <option key={t.task} value={t.task}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Model (Hugging Face id)" hint={<a href={href('hub', {})}>Browse compatible models</a>}>
                  <Input value={model} onChange={(e) => setModel(e.target.value)} />
                </Field>
                <Field label="Precision (dtype)" hint="q4/q8 are smaller and faster; fp16 needs WebGPU">
                  <Select value={dtype} onChange={(e) => setDtype(e.target.value)}>
                    {DTYPES.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <span className="small subtle">{info.hint}</span>
              <div className="row">
                <Button icon="download" loading={busy && status.startsWith('Loading')} disabled={busy || !model.trim()} onClick={load}>
                  Load model
                </Button>
                {status ? <span className="small muted">{status}</span> : null}
              </div>
              {progressList.length && totalLoaded < totalSize ? (
                <div className="stack sm">
                  <Progress value={totalSize ? totalLoaded / totalSize : 0} />
                  <span className="small subtle">
                    {formatBytes(totalLoaded)} / {formatBytes(totalSize)} · {progressList.length} files
                  </span>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Input">
            <div className="stack">
              {info.input === 'chat' ? (
                <Field label="System prompt">
                  <Textarea rows={2} value={system} onChange={(e) => setSystem(e.target.value)} />
                </Field>
              ) : null}
              {info.input !== 'image' && info.input !== 'audio' ? (
                <Field
                  label={
                    info.input === 'qa'
                      ? 'Question'
                      : task === 'feature-extraction'
                        ? 'Sentences (one per line)'
                        : task === 'fill-mask'
                          ? 'Text with [MASK] (or <mask>)'
                          : info.input === 'chat'
                            ? 'Message'
                            : 'Text'
                  }
                >
                  <Textarea rows={task === 'summarization' || task === 'feature-extraction' ? 8 : 4} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
              ) : null}
              {info.input === 'text-labels' ? (
                <Field label="Candidate labels" hint="Comma-separated">
                  <Input value={labels} onChange={(e) => setLabels(e.target.value)} />
                </Field>
              ) : null}
              {info.input === 'qa' ? (
                <Field label="Context">
                  <Textarea rows={6} value={context} onChange={(e) => setContext(e.target.value)} />
                </Field>
              ) : null}
              {info.input === 'image' || info.input === 'audio' ? (
                <Field label={info.input === 'image' ? 'Image' : 'Audio file'}>
                  <input type="file" accept={info.input === 'image' ? 'image/*' : 'audio/*'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </Field>
              ) : null}
              {fileUrl && info.input === 'image' ? <img src={fileUrl} alt="Selected input" style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 8 }} /> : null}
              {fileUrl && info.input === 'audio' ? <audio controls src={fileUrl} /> : null}
              <details>
                <summary>Advanced options (JSON)</summary>
                <Textarea
                  rows={3}
                  className="mono"
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  placeholder={
                    task === 'text-generation'
                      ? '{"max_new_tokens": 256, "do_sample": true, "temperature": 0.7}'
                      : task === 'translation'
                        ? '{"src_lang": "eng_Latn", "tgt_lang": "fra_Latn"}'
                        : task === 'automatic-speech-recognition'
                          ? '{"chunk_length_s": 30, "return_timestamps": true}'
                          : '{"top_k": 5}'
                  }
                />
              </details>
              <div className="row">
                <Button variant="primary" icon="play" loading={busy && !status.startsWith('Loading')} disabled={busy || !model.trim()} onClick={run}>
                  Run
                </Button>
                {busy && task === 'text-generation' ? (
                  <Button icon="stop" onClick={() => interruptGeneration()}>
                    Stop
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          {error ? <Notice tone="err">{error}</Notice> : null}
          {streamed || result ? (
            <Card title="Output" actions={result?.ms != null ? <Badge>{formatMs(result.ms)} · {result.device}</Badge> : null}>
              <OutputView task={task} streamed={streamed} result={result?.data} inputText={text} />
            </Card>
          ) : null}
        </div>
        <div className="stack">
          <Environment onImported={setModel} />
          <Card title="Tips">
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Search the Hugging Face page with the “Transformers.js” library filter to find compatible models.</li>
              <li>Models download once and are cached in your browser; clear the cache above to reclaim space.</li>
              <li>For fully offline use, put ONNX models in <code>public/models/</code> of your deployment and disable remote downloads.</li>
              <li>Large models (1B+) need WebGPU and enough GPU memory; start small.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

function OutputView({ task, streamed, result, inputText }: { task: string; streamed: string; result: unknown; inputText: string }) {
  const sentences = useMemo(() => inputText.split('\n').map((l) => l.trim()).filter(Boolean), [inputText]);

  if (task === 'text-generation') {
    const text = typeof result === 'string' ? result : streamed;
    return <Markdown text={text || '…'} />;
  }

  if (task === 'feature-extraction' && result && typeof result === 'object') {
    const data = (result as { data?: unknown; dims?: number[] }).data;
    const dims = (result as { dims?: number[] }).dims;
    const vectors = Array.isArray(data) && Array.isArray(data[0]) ? (data as number[][]) : Array.isArray(data) ? [data as number[]] : [];
    return (
      <div className="stack">
        <span className="small muted">
          {vectors.length} embedding{vectors.length === 1 ? '' : 's'} · dims [{dims?.join(', ')}]
        </span>
        {vectors.length > 1 ? (
          <div className="table-wrap">
            <table className="table heat">
              <thead>
                <tr>
                  <th>cosine similarity</th>
                  {vectors.map((_, i) => (
                    <th key={i} className="num">
                      #{i + 1}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vectors.map((a, i) => (
                  <tr key={i}>
                    <td className="ellipsis" style={{ maxWidth: 260 }} title={sentences[i]}>
                      #{i + 1} {sentences[i]}
                    </td>
                    {vectors.map((b, j) => {
                      const s = cosine(a, b);
                      return (
                        <td key={j} className="num" style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(Math.max(0, s) * 45)}%, transparent)` }}>
                          {s.toFixed(3)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <details>
          <summary>Raw vectors</summary>
          <JsonView value={result} filename="embeddings.json" />
        </details>
      </div>
    );
  }

  type Scored = { label: string; score: number; token_str?: string; word?: string; entity?: string; box?: unknown };
  const list = Array.isArray(result) ? (Array.isArray(result[0]) ? (result[0] as unknown[]) : (result as unknown[])) : null;
  const labelScores =
    list && list.length && list.every((x) => x && typeof x === 'object' && 'label' in (x as object) && 'score' in (x as object))
      ? (list as Scored[])
      : null;
  const zeroShot = result && typeof result === 'object' && 'labels' in (result as object) && 'scores' in (result as object) ? (result as { labels: string[]; scores: number[] }) : null;
  const generated =
    list && list.every((x) => x && typeof x === 'object' && ('generated_text' in (x as object) || 'summary_text' in (x as object) || 'translation_text' in (x as object)))
      ? list.map((x) => {
          const o = x as Record<string, string>;
          return o.generated_text ?? o.summary_text ?? o.translation_text;
        })
      : null;
  const asrText = result && typeof result === 'object' && 'text' in (result as object) ? String((result as { text: unknown }).text) : null;
  const qa = result && typeof result === 'object' && 'answer' in (result as object) ? (result as { answer: string; score: number }) : null;

  return (
    <div className="stack">
      {zeroShot ? (
        <HBarList items={zeroShot.labels.map((l, i) => ({ label: l, value: zeroShot.scores[i], display: `${(zeroShot.scores[i] * 100).toFixed(1)}%` }))} />
      ) : labelScores && !labelScores.some((x) => x.box !== undefined) ? (
        <HBarList
          items={labelScores.map((x) => ({
            label: x.token_str ?? x.word ?? x.label,
            value: x.score,
            display: `${(x.score * 100).toFixed(1)}%${x.entity ? ` · ${x.entity}` : ''}`,
          }))}
        />
      ) : null}
      {generated ? generated.map((g, i) => <Markdown key={i} text={g} />) : null}
      {asrText ? <p style={{ margin: 0 }}>{asrText}</p> : null}
      {qa ? (
        <Notice tone="ok">
          <strong>{qa.answer}</strong> <span className="subtle">(confidence {(qa.score * 100).toFixed(1)}%)</span>
        </Notice>
      ) : null}
      <details open={!(zeroShot || (labelScores && !labelScores.some((x) => x.box !== undefined)) || generated?.length || asrText || qa)}>
        <summary>Raw output</summary>
        <JsonView value={result} filename={`${task}-output.json`} />
      </details>
    </div>
  );
}
