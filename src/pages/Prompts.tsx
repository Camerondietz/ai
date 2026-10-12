import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/ModelPicker';
import { Badge, Button, Card, EmptyState, Field, Input, Notice, PageHeader, Textarea } from '../components/ui';
import { useCollection } from '../lib/collection';
import { downloadJSON, pickFiles, timestampSlug } from '../lib/download';
import { formatDateTime, formatMs, formatRelative, formatUSD, slugify } from '../lib/format';
import { uid } from '../lib/id';
import { extractVariables, renderTemplate } from '../lib/template';
import { describeError, runChat } from '../providers';
import { navigate, useRoute } from '../router';
import { prompts } from '../state/collections';
import { setChatHandoff } from '../state/handoff';
import { getSettings } from '../state/settings';
import { toast, toastError } from '../state/toast';
import type { ModelRef, PromptTemplate, PromptVersion } from '../state/types';

const PROMPT_FORMAT = 'ai-workbench/prompts';

function blankPrompt(): PromptTemplate {
  const now = Date.now();
  return {
    id: uid(),
    name: 'Untitled prompt',
    description: '',
    tags: [],
    versions: [{ version: 1, system: '', template: 'Answer the question.\n\nQuestion: {{question}}', createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
}

function isPrompt(x: unknown): x is PromptTemplate {
  const p = x as PromptTemplate;
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.versions);
}

async function importPrompts() {
  const [file] = await pickFiles('.json,application/json');
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { prompts?: unknown[] }).prompts ?? [parsed];
    const valid = list.filter(isPrompt).map((p) => ({ ...p, tags: p.tags ?? [], description: p.description ?? '' }));
    if (!valid.length) throw new Error('No prompts found in this file.');
    await prompts.putMany(valid);
    toast(`Imported ${valid.length} prompt${valid.length === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    toastError(err, 'Import failed');
  }
}

export function PromptsPage() {
  const route = useRoute();
  const { items, loaded } = useCollection(prompts);
  const [q, setQ] = useState('');
  const id = route.segments[1];
  const active = id ? items.find((p) => p.id === id) : undefined;

  useEffect(() => {
    if (!id && loaded && items.length) navigate(`prompts/${items[0].id}`);
  }, [id, loaded, items]);

  const filtered = items.filter((p) => !q || `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));

  const create = async () => {
    const p = blankPrompt();
    await prompts.put(p);
    navigate(`prompts/${p.id}`);
  };

  return (
    <div className="page">
      <PageHeader
        title="Prompt library"
        description="Versioned prompt templates with {{variables}}. Test them against any model, open them in chat, or evaluate them on a dataset."
        actions={
          <>
            <Button icon="upload" onClick={importPrompts}>
              Import
            </Button>
            <Button
              icon="download"
              disabled={!items.length}
              onClick={() => downloadJSON({ format: PROMPT_FORMAT, version: 1, prompts: items }, `prompts-${timestampSlug()}.json`)}
            >
              Export all
            </Button>
            <Button variant="primary" icon="plus" onClick={create}>
              New prompt
            </Button>
          </>
        }
      />
      {loaded && !items.length ? (
        <Card>
          <EmptyState title="No prompts yet" action={<Button variant="primary" onClick={create}>Create your first prompt</Button>}>
            Prompts you save here are versioned, so you can iterate safely and compare versions in evaluations.
          </EmptyState>
        </Card>
      ) : (
        <div className="split">
          <Card bodyClassName="">
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
              <Input placeholder="Search prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="list">
              {filtered.map((p) => (
                <a key={p.id} href={`#/prompts/${p.id}`} className={`list-item ${p.id === id ? 'active' : ''}`} style={{ textDecoration: 'none' }}>
                  <div className="title ellipsis">{p.name}</div>
                  <div className="meta">
                    v{p.versions[p.versions.length - 1]?.version ?? 1} · {formatRelative(p.updatedAt)}
                    {p.tags.length ? ` · ${p.tags.join(', ')}` : ''}
                  </div>
                </a>
              ))}
            </div>
          </Card>
          {active ? <PromptEditor key={active.id} prompt={active} /> : null}
        </div>
      )}
    </div>
  );
}

function PromptEditor({ prompt }: { prompt: PromptTemplate }) {
  const latest = prompt.versions[prompt.versions.length - 1];
  const [name, setName] = useState(prompt.name);
  const [description, setDescription] = useState(prompt.description);
  const [tags, setTags] = useState(prompt.tags.join(', '));
  const [system, setSystem] = useState(latest?.system ?? '');
  const [template, setTemplate] = useState(latest?.template ?? '');
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [model, setModel] = useState<ModelRef | undefined>(getSettings().defaultModel);
  const [testing, setTesting] = useState(false);
  const [output, setOutput] = useState<{ text: string; meta: string; error?: string } | null>(null);
  const [history, setHistory] = useState(false);

  const variables = useMemo(() => [...new Set([...extractVariables(system), ...extractVariables(template)])], [system, template]);
  const rendered = renderTemplate(template, values);
  const renderedSystem = renderTemplate(system, values);
  const dirty = system !== (latest?.system ?? '') || template !== (latest?.template ?? '');
  const metaDirty = name !== prompt.name || description !== prompt.description || tags !== prompt.tags.join(', ');

  const saveMeta = async () => {
    await prompts.put({
      ...prompt,
      name: name.trim() || 'Untitled prompt',
      description,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      updatedAt: Date.now(),
    });
  };

  const saveVersion = async () => {
    const version: PromptVersion = {
      version: (latest?.version ?? 0) + 1,
      system,
      template,
      note: note.trim() || undefined,
      createdAt: Date.now(),
    };
    await prompts.put({
      ...prompt,
      name: name.trim() || 'Untitled prompt',
      description,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      versions: [...prompt.versions, version],
      updatedAt: Date.now(),
    });
    setNote('');
    toast(`Saved version ${version.version}`, 'success');
  };

  const test = async () => {
    if (!model) return;
    setTesting(true);
    setOutput({ text: '', meta: '' });
    let text = '';
    try {
      const r = await runChat({
        providerId: model.providerId,
        model: model.model,
        system: renderedSystem.text,
        messages: [{ role: 'user', content: rendered.text }],
        params: {},
        source: 'other',
        onDelta: (t) => {
          text += t;
          setOutput({ text, meta: '' });
        },
      });
      setOutput({ text: r.text, meta: `${formatMs(r.latencyMs)} · ${r.usage?.inputTokens ?? 0}→${r.usage?.outputTokens ?? 0} tok · ${formatUSD(r.costUsd)}` });
    } catch (err) {
      setOutput({ text, meta: '', error: describeError(err) });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${prompt.name}" and all its versions?`)) return;
    await prompts.remove(prompt.id);
    navigate('prompts');
  };

  return (
    <div className="stack">
      <Card
        title={
          <div className="row">
            <h2>{prompt.name}</h2>
            <Badge>v{latest?.version ?? 1}</Badge>
            {dirty ? <Badge tone="warn">unsaved changes</Badge> : null}
          </div>
        }
        actions={
          <>
            <Button size="sm" icon="history" onClick={() => setHistory(true)}>
              History ({prompt.versions.length})
            </Button>
            <Button size="sm" icon="download" onClick={() => downloadJSON({ format: PROMPT_FORMAT, version: 1, prompts: [prompt] }, `${slugify(prompt.name)}.prompt.json`)}>
              Export
            </Button>
            <Button size="sm" variant="ghost" iconOnly icon="trash" aria-label="Delete prompt" onClick={remove} />
          </>
        }
      >
        <div className="stack">
          <div className="grid cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => metaDirty && void saveMeta()} />
            </Field>
            <Field label="Tags" hint="Comma-separated">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => metaDirty && void saveMeta()} />
            </Field>
          </div>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => metaDirty && void saveMeta()} />
          </Field>
          <Field label="System prompt">
            <Textarea rows={4} className="mono" value={system} onChange={(e) => setSystem(e.target.value)} />
          </Field>
          <Field label="User message template" hint="Use {{variable}} placeholders. In evaluations they map to dataset columns.">
            <Textarea rows={7} className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} />
          </Field>
          <div className="row">
            <div className="flex-1">
              <Input placeholder="Version note (optional), e.g. “stricter output format”" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button variant="primary" icon="check" disabled={!dirty} onClick={saveVersion}>
              Save as v{(latest?.version ?? 0) + 1}
            </Button>
          </div>
          <div className="row">
            <Button
              icon="chat"
              onClick={() => {
                setChatHandoff({ system: renderedSystem.text, input: rendered.text, providerId: model?.providerId, model: model?.model });
                navigate('chat', { new: '1' });
              }}
            >
              Open in chat
            </Button>
            <Button icon="beaker" onClick={() => navigate('evals', { new: '1', prompt: prompt.id })}>
              Evaluate on a dataset
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Test">
        <div className="stack">
          {variables.length ? (
            <div className="grid cols-2">
              {variables.map((v) => (
                <Field key={v} label={`{{${v}}}`}>
                  <Textarea rows={2} value={values[v] ?? ''} onChange={(e) => setValues({ ...values, [v]: e.target.value })} />
                </Field>
              ))}
            </div>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              No variables in this template.
            </p>
          )}
          {rendered.missing.length ? <Notice tone="warn">Missing values: {rendered.missing.join(', ')}</Notice> : null}
          <details>
            <summary>Preview rendered prompt</summary>
            <pre className="plain mono">{(renderedSystem.text ? `[system]\n${renderedSystem.text}\n\n[user]\n` : '') + rendered.text}</pre>
          </details>
          <div className="row">
            <div style={{ minWidth: 260 }}>
              <ModelPicker value={model} onChange={setModel} />
            </div>
            <Button variant="primary" icon="play" loading={testing} disabled={!model} onClick={test}>
              Run test
            </Button>
          </div>
          {output ? (
            <div className="stack sm">
              {output.meta ? <span className="small subtle">{output.meta}</span> : null}
              {output.error ? <Notice tone="err">{output.error}</Notice> : null}
              {output.text ? (
                <div className="card card-body">
                  <Markdown text={output.text} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      {history ? (
        <Modal title={`Version history — ${prompt.name}`} onClose={() => setHistory(false)} wide>
          <div className="stack">
            {[...prompt.versions].reverse().map((v) => (
              <div key={v.version} className="card card-body stack sm">
                <div className="row between">
                  <div className="row">
                    <Badge tone="accent">v{v.version}</Badge>
                    <span className="small subtle">{formatDateTime(v.createdAt)}</span>
                    {v.note ? <span className="small">{v.note}</span> : null}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      setSystem(v.system);
                      setTemplate(v.template);
                      setHistory(false);
                      toast(`Loaded v${v.version} into the editor. Save to make it the latest version.`, 'info');
                    }}
                  >
                    Load into editor
                  </Button>
                </div>
                {v.system ? <pre className="plain mono small">{v.system}</pre> : null}
                <pre className="plain mono small">{v.template}</pre>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
