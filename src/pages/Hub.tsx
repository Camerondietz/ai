import { useEffect, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { Badge, Button, Card, EmptyState, Input, KeyValues, Notice, PageHeader, Select, Spinner, Tabs } from '../components/ui';
import { formatBytes, formatCompact, formatRelative } from '../lib/format';
import { fetchRepoText, repoInfo, repoPageUrl, repoTree, resolveUrl, searchRepos, whoAmI, type HFRepoInfo, type HFRepoSummary, type TreeEntry, type WhoAmI } from '../lib/hf';
import { uid } from '../lib/id';
import { describeError } from '../providers';
import { HF_TOKEN_SECRET } from '../providers/presets';
import { href, navigate, useRoute } from '../router';
import { models } from '../state/collections';
import { setChatHandoff } from '../state/handoff';
import { addProviderFromPreset, getSettings, upsertProvider } from '../state/settings';
import { toast } from '../state/toast';
import { hasSecret, useVault } from '../state/vault';
import { LOCAL_TASKS } from '../workers/protocol';

type Kind = 'model' | 'dataset';

const TASKS = [
  'text-generation',
  'image-text-to-text',
  'feature-extraction',
  'sentence-similarity',
  'text-classification',
  'token-classification',
  'zero-shot-classification',
  'question-answering',
  'summarization',
  'translation',
  'fill-mask',
  'image-classification',
  'object-detection',
  'image-to-text',
  'automatic-speech-recognition',
  'text-to-speech',
  'text-to-image',
];

const LIBRARIES = [
  { value: '', label: 'Any library' },
  { value: 'transformers.js', label: 'Transformers.js (runs in browser)' },
  { value: 'onnx', label: 'ONNX' },
  { value: 'gguf', label: 'GGUF (llama.cpp, Ollama, LM Studio)' },
  { value: 'mlx', label: 'MLX (Apple silicon)' },
  { value: 'transformers', label: 'Transformers (PyTorch)' },
  { value: 'sentence-transformers', label: 'Sentence Transformers' },
  { value: 'peft', label: 'PEFT adapters' },
];

export function HubPage() {
  const route = useRoute();
  useVault();
  const [kind, setKind] = useState<Kind>(route.query.get('dataset') ? 'dataset' : 'model');
  const [query, setQuery] = useState('');
  const [task, setTask] = useState('');
  const [library, setLibrary] = useState('');
  const [sort, setSort] = useState<'downloads' | 'likes' | 'trendingScore' | 'lastModified'>('trendingScore');
  const [results, setResults] = useState<HFRepoSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = route.query.get(kind) ?? undefined;

  const search = async () => {
    setBusy(true);
    setError('');
    try {
      setResults(
        await searchRepos(kind, {
          search: query.trim() || undefined,
          pipelineTag: kind === 'model' ? task || undefined : undefined,
          filter: kind === 'model' ? library || undefined : undefined,
          sort,
          limit: 40,
        }),
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, task, library, sort]);

  return (
    <div className="page">
      <PageHeader
        title="Hugging Face"
        description="Search the Hub, read model cards, inspect weights, run compatible models in your browser, call hosted models, and import datasets."
        actions={<AccountBadge />}
      />
      <Tabs
        tabs={[
          { id: 'model', label: 'Models' },
          { id: 'dataset', label: 'Datasets' },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setResults(null);
        }}
      />
      <div className="split" style={{ gridTemplateColumns: 'minmax(320px, 420px) minmax(0, 1fr)' }}>
        <div className="stack">
          <Card>
            <div className="stack">
              <form
                className="row nowrap"
                onSubmit={(e) => {
                  e.preventDefault();
                  void search();
                }}
              >
                <Input placeholder={kind === 'model' ? 'Search models…' : 'Search datasets…'} value={query} onChange={(e) => setQuery(e.target.value)} />
                <Button type="submit" variant="primary" iconOnly icon="search" aria-label="Search" />
              </form>
              {kind === 'model' ? (
                <div className="grid cols-2">
                  <Select value={task} onChange={(e) => setTask(e.target.value)}>
                    <option value="">Any task</option>
                    {TASKS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                  <Select value={library} onChange={(e) => setLibrary(e.target.value)}>
                    {LIBRARIES.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="trendingScore">Trending</option>
                <option value="downloads">Most downloads</option>
                <option value="likes">Most likes</option>
                <option value="lastModified">Recently updated</option>
              </Select>
            </div>
          </Card>
          {error ? <Notice tone="err">{error}</Notice> : null}
          <Card bodyClassName="">
            {busy && !results ? (
              <div className="card-body">
                <Spinner label="Searching…" />
              </div>
            ) : results?.length ? (
              <div className="list" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                {results.map((r) => (
                  <a key={r.id} href={href('hub', { [kind]: r.id })} className={`list-item ${selected === r.id ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
                    <div className="title ellipsis">{r.id}</div>
                    <div className="meta row">
                      {r.pipeline_tag ? <span>{r.pipeline_tag}</span> : null}
                      <span>↓ {formatCompact(r.downloads ?? 0)}</span>
                      <span>♥ {formatCompact(r.likes ?? 0)}</span>
                      {r.gated ? <Badge tone="warn">gated</Badge> : null}
                    </div>
                  </a>
                ))}
              </div>
            ) : results ? (
              <EmptyState title="No results" />
            ) : null}
          </Card>
        </div>
        <div>{selected ? <RepoDetail key={`${kind}:${selected}`} kind={kind} id={selected} /> : <Card><EmptyState title="Select a repository">Pick a result to see its card, files and actions.</EmptyState></Card>}</div>
      </div>
    </div>
  );
}

function AccountBadge() {
  const [me, setMe] = useState<WhoAmI | null>(null);
  const [busy, setBusy] = useState(false);
  if (!hasSecret(HF_TOKEN_SECRET)) {
    return (
      <Button icon="key" onClick={() => navigate('settings', { tab: 'huggingface' })}>
        Add HF token (optional)
      </Button>
    );
  }
  if (me) {
    return (
      <Badge tone="ok" title={me.orgs?.length ? `Orgs: ${me.orgs.map((o) => o.name).join(', ')}` : undefined}>
        Signed in as {me.name}
        {me.auth?.accessToken?.role ? ` · ${me.auth.accessToken.role} token` : ''}
      </Badge>
    );
  }
  return (
    <Button
      icon="key"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          setMe(await whoAmI());
        } catch (err) {
          toast(describeError(err), 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      Check token
    </Button>
  );
}

function stripFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function RepoDetail({ kind, id }: { kind: Kind; id: string }) {
  const [info, setInfo] = useState<HFRepoInfo | null>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [files, setFiles] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'card' | 'files'>('card');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const i = await repoInfo(kind, id);
        if (cancelled) return;
        setInfo(i);
        const hasReadme = i.siblings?.some((s) => s.rfilename === 'README.md') ?? true;
        if (hasReadme) {
          fetchRepoText(kind, id, 'README.md')
            .then((t) => !cancelled && setReadme(stripFrontMatter(t)))
            .catch(() => !cancelled && setReadme(''));
        } else setReadme('');
      } catch (err) {
        if (!cancelled) setError(describeError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  useEffect(() => {
    if (tab !== 'files' || files) return;
    repoTree(kind, id)
      .then((t) => setFiles(t.filter((f) => f.type === 'file')))
      .catch((err) => setError(describeError(err)));
  }, [tab, files, kind, id]);

  if (error) return <Notice tone="err">{error}</Notice>;
  if (!info) return <Spinner label="Loading…" />;

  const tags = info.tags ?? [];
  const browserReady = tags.includes('transformers.js') || (tags.includes('onnx') && !!info.pipeline_tag);
  const localTask = LOCAL_TASKS.find((t) => t.task === info.pipeline_tag);
  const chatCapable = info.pipeline_tag === 'text-generation' || info.pipeline_tag === 'image-text-to-text';
  const license = (info.cardData?.license as string | undefined) ?? tags.find((t) => t.startsWith('license:'))?.slice(8);
  const params = info.safetensors?.total ?? info.gguf?.total;

  const chatViaRouter = () => {
    const s = getSettings();
    let provider = s.providers.find((p) => p.preset === 'huggingface');
    if (!provider) provider = addProviderFromPreset('huggingface');
    if (!provider.models.includes(id)) upsertProvider({ ...provider, models: [...provider.models, id] });
    setChatHandoff({ providerId: provider.id, model: id });
    navigate('chat', { new: '1' });
    if (!hasSecret(HF_TOKEN_SECRET)) toast('Add your Hugging Face token in Settings to call Inference Providers.', 'warning');
  };

  const addToRegistry = async () => {
    const now = Date.now();
    await models.put({
      id: uid(),
      name: id,
      kind: 'hub',
      source: id,
      format: tags.includes('gguf') ? 'gguf' : tags.includes('onnx') ? 'onnx' : tags.includes('safetensors') ? 'safetensors' : undefined,
      params,
      tags: [info.pipeline_tag, info.library_name].filter((t): t is string => !!t),
      notes: '',
      metadata: { license, pipeline_tag: info.pipeline_tag, library_name: info.library_name, sha: info.sha },
      createdAt: now,
      updatedAt: now,
    });
    toast('Added to model registry', 'success');
  };

  return (
    <Card
      title={
        <div className="stack sm" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{id}</h2>
          <div className="row">
            {info.pipeline_tag ? <Badge tone="accent">{info.pipeline_tag}</Badge> : null}
            {info.library_name ? <Badge>{info.library_name}</Badge> : null}
            {license ? <Badge>license: {license}</Badge> : null}
            {info.gated ? <Badge tone="warn">gated</Badge> : null}
            {info.private ? <Badge tone="warn">private</Badge> : null}
          </div>
        </div>
      }
      actions={
        <a className="btn sm" href={repoPageUrl(kind, id)} target="_blank" rel="noopener noreferrer">
          Open on HF ↗
        </a>
      }
    >
      <div className="stack">
        <KeyValues
          items={[
            ['Downloads (30d)', formatCompact(info.downloads ?? 0)],
            ['Likes', formatCompact(info.likes ?? 0)],
            ...(params ? ([['Parameters', formatCompact(params)]] as [string, string][]) : []),
            ['Updated', info.lastModified ? formatRelative(Date.parse(info.lastModified)) : '—'],
          ]}
        />
        <div className="row">
          {kind === 'model' ? (
            <>
              <Button size="sm" icon="cpu" onClick={() => navigate('models', { tab: 'remote', repo: id })}>
                Inspect weights
              </Button>
              {browserReady ? (
                <Button size="sm" icon="zap" onClick={() => navigate('lab', { model: id, task: localTask?.task ?? info.pipeline_tag ?? '' })}>
                  Run in browser
                </Button>
              ) : null}
              {chatCapable ? (
                <Button size="sm" icon="chat" onClick={chatViaRouter} title="Hosted inference via Hugging Face Inference Providers (if a provider serves this model)">
                  Chat via HF Inference
                </Button>
              ) : null}
              <Button size="sm" icon="plus" onClick={addToRegistry}>
                Add to registry
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" icon="table" onClick={() => navigate('datasets', { import: '1', hf: id })}>
              Import rows
            </Button>
          )}
        </div>
        {tags.includes('gguf') ? (
          <Notice>
            GGUF model: run it locally with Ollama (<code>ollama run hf.co/{id}</code>) or LM Studio, then chat with it here through the Ollama / LM Studio
            provider.
          </Notice>
        ) : null}
        <Tabs
          tabs={[
            { id: 'card', label: kind === 'model' ? 'Model card' : 'Dataset card' },
            { id: 'files', label: 'Files' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'card' ? (
          readme == null ? (
            <Spinner label="Loading card…" />
          ) : readme.trim() ? (
            <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
              <Markdown text={readme} />
            </div>
          ) : (
            <span className="muted">No card.</span>
          )
        ) : files ? (
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th className="num">Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.path}>
                    <td>
                      <code>{f.path}</code>
                    </td>
                    <td className="num">{formatBytes(f.lfs?.size ?? f.size)}</td>
                    <td className="right">
                      <a className="small" href={resolveUrl(kind, id, f.path)} target="_blank" rel="noopener noreferrer">
                        download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Spinner label="Loading files…" />
        )}
      </div>
    </Card>
  );
}
