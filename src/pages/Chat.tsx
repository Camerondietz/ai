import { useEffect, useMemo, useRef, useState } from 'react';
import { CodeExportDialog } from '../components/CodeExportDialog';
import { Icon } from '../components/icons';
import { JsonView } from '../components/JsonView';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { ModelPicker } from '../components/ModelPicker';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Notice, NumberInput, Select, Textarea } from '../components/ui';
import { useCollection } from '../lib/collection';
import { copyText, downloadJSON, downloadText, timestampSlug } from '../lib/download';
import { formatCompact, formatMs, formatRelative, formatUSD, slugify, truncate } from '../lib/format';
import { uid } from '../lib/id';
import { estimateTokens } from '../lib/tokens';
import { anthropicSupportsAdaptive, anthropicSupportsSampling } from '../providers/anthropic';
import { describeError, isBlockedError, runChat } from '../providers';
import { navigate, useRoute } from '../router';
import { conversations, prompts } from '../state/collections';
import { allowHost, getProvider, getSettings, useSettings } from '../state/settings';
import { takeChatHandoff } from '../state/handoff';
import { toast } from '../state/toast';
import type { ChatParams, Conversation, Effort, PromptTemplate, StoredMessage } from '../state/types';

function newConversation(providerHint?: string | null): Conversation {
  const s = getSettings();
  const now = Date.now();
  let ref = s.defaultModel;
  const hinted = providerHint ? getProvider(providerHint) : undefined;
  if (hinted) ref = { providerId: hinted.id, model: hinted.defaultModel ?? hinted.models[0] ?? '' };
  if (!ref || !getProvider(ref.providerId)?.enabled) {
    const p = s.providers.find((x) => x.enabled && x.models.length);
    ref = p ? { providerId: p.id, model: p.defaultModel ?? p.models[0] } : { providerId: '', model: '' };
  }
  return { id: uid(), title: 'New chat', createdAt: now, updatedAt: now, providerId: ref.providerId, model: ref.model, system: '', params: {}, messages: [] };
}

function deriveTitle(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 60) || 'New chat';
}

function toMarkdown(c: Conversation): string {
  const lines = [`# ${c.title}`, '', `Model: ${c.model} · Exported ${new Date().toISOString()}`, ''];
  if (c.system) lines.push('## System', '', c.system, '');
  for (const m of c.messages) {
    lines.push(`## ${m.role === 'user' ? 'User' : `Assistant${m.model ? ` (${m.model})` : ''}`}`, '', m.error ? `> Error: ${m.error}` : m.content, '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

export function ChatPage() {
  const route = useRoute();
  const { items, loaded } = useCollection(conversations);
  const [draft, setDraft] = useState<Conversation | null>(null);
  const [draftInput, setDraftInput] = useState('');
  const [search, setSearch] = useState('');
  const [listOpen, setListOpen] = useState(false);
  const id = route.segments[1];
  const isNew = route.query.get('new') === '1';
  const providerHint = route.query.get('provider');

  useEffect(() => {
    if (!id && (isNew || !draft)) {
      const c = newConversation(providerHint);
      const handoff = takeChatHandoff();
      if (handoff?.system) c.system = handoff.system;
      if (handoff?.providerId && handoff.model && getProvider(handoff.providerId)) {
        c.providerId = handoff.providerId;
        c.model = handoff.model;
      }
      setDraftInput(handoff?.input ?? '');
      setDraft(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew, providerHint]);

  const active = id ? items.find((c) => c.id === id) : (draft ?? undefined);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  }, [items, search]);

  // Drafts live in memory until they get their first message. The draft keeps
  // its id when saved, so the open ChatView (keyed by id) is never remounted
  // mid-stream.
  const persist = async (c: Conversation) => {
    if (!id && !c.messages.length) {
      setDraft(c);
      return;
    }
    await conversations.put(c);
    if (id !== c.id) navigate(`chat/${c.id}`);
  };

  return (
    <div className="page full">
      <div className="chat">
        <aside className={`chat-list ${listOpen ? 'open' : ''}`}>
          <div className="stack sm" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <Button variant="primary" icon="plus" onClick={() => navigate('chat', { new: '1' })}>
              New chat
            </Button>
            <Input placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="list" onClick={() => setListOpen(false)}>
            {filtered.map((c) => (
              <a key={c.id} className={`list-item ${active?.id === c.id ? 'active' : ''}`} href={`#/chat/${c.id}`} style={{ textDecoration: 'none' }}>
                <div className="row nowrap">
                  {c.pinned ? <Icon name="pin" size={12} /> : null}
                  <span className="title ellipsis flex-1">{c.title}</span>
                </div>
                <div className="meta ellipsis">
                  {c.model || 'no model'} · {formatRelative(c.updatedAt)}
                </div>
              </a>
            ))}
            {loaded && !filtered.length ? <p className="subtle small" style={{ padding: 14 }}>{search ? 'No matches.' : 'No saved chats yet.'}</p> : null}
          </div>
        </aside>

        {active ? (
          <ChatView
            key={active.id}
            conversation={active}
            persist={persist}
            isDraft={!id}
            initialInput={!id ? draftInput : ''}
            onToggleList={() => setListOpen((o) => !o)}
          />
        ) : loaded && id ? (
          <div className="chat-main">
            <EmptyState title="Conversation not found" action={<Button onClick={() => navigate('chat', { new: '1' })}>New chat</Button>}>
              It may have been deleted.
            </EmptyState>
          </div>
        ) : (
          <div className="chat-main" />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface StreamState {
  text: string;
  thinking: string;
  status: string;
}

function ChatView({
  conversation: conv,
  persist,
  isDraft,
  initialInput,
  onToggleList,
}: {
  conversation: Conversation;
  persist: (c: Conversation) => Promise<void>;
  isDraft: boolean;
  initialInput: string;
  onToggleList: () => void;
}) {
  useSettings(); // re-render when providers or models change
  const [input, setInput] = useState(initialInput);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [panel, setPanel] = useState<'system' | 'params' | null>(null);
  const [inspect, setInspect] = useState<StoredMessage | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pending = useRef<StreamState>({ text: '', thinking: '', status: '' });
  const frame = useRef<number | null>(null);
  const stickToBottom = useRef(true);

  const provider = getProvider(conv.providerId);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, stream]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const update = (patch: Partial<Conversation>) => persist({ ...conv, ...patch, updatedAt: Date.now() });

  const flush = () => {
    frame.current = null;
    setStream({ ...pending.current });
  };
  const schedule = () => {
    if (frame.current == null) frame.current = requestAnimationFrame(flush);
  };

  const generate = async (base: Conversation) => {
    const controller = new AbortController();
    abortRef.current = controller;
    pending.current = { text: '', thinking: '', status: '' };
    setStream({ ...pending.current });
    stickToBottom.current = true;
    const history = base.messages.filter((m) => !m.error && (m.role !== 'assistant' || m.content)).map((m) => ({ role: m.role, content: m.content }));
    try {
      const result = await runChat({
        providerId: base.providerId,
        model: base.model,
        system: base.system,
        messages: history,
        params: base.params,
        source: 'chat',
        signal: controller.signal,
        onDelta: (t) => {
          pending.current.text += t;
          pending.current.status = '';
          schedule();
        },
        onThinking: (t) => {
          pending.current.thinking += t;
          schedule();
        },
        onStatus: (s) => {
          pending.current.status = s;
          schedule();
        },
      });
      const message: StoredMessage = {
        id: uid(),
        role: 'assistant',
        content: result.text,
        thinking: result.thinking || pending.current.thinking || undefined,
        createdAt: Date.now(),
        providerId: base.providerId,
        model: result.model || base.model,
        usage: result.usage,
        latencyMs: result.latencyMs,
        firstTokenMs: result.firstTokenMs,
        costUsd: result.costUsd,
        stopReason: result.stopReason,
        inspect: getSettings().storeInspect && result.request ? { request: result.request, response: result.response } : undefined,
      };
      await persist({ ...base, messages: [...base.messages, message], updatedAt: Date.now() });
      if (result.stopReason === 'refusal') toast('The model declined this request (stop reason: refusal).', 'warning');
      if (result.stopReason === 'max_tokens' || result.stopReason === 'length') toast('Response hit the max tokens limit and was cut off.', 'warning');
    } catch (err) {
      const message: StoredMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        error: describeError(err),
        createdAt: Date.now(),
        providerId: base.providerId,
        model: base.model,
      };
      await persist({ ...base, messages: [...base.messages, message], updatedAt: Date.now() });
      if (isBlockedError(err)) {
        const host = err.host;
        toast(`Request to ${host} was blocked by your network policy.`, 'warning', { label: `Allow ${host}`, run: () => allowHost(host.replace(/:\d+$/, '')) });
      }
    } finally {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setStream(null);
      abortRef.current = null;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || stream) return;
    if (!conv.model) {
      toast('Pick a model first.', 'warning');
      return;
    }
    const message: StoredMessage = { id: uid(), role: 'user', content: text, createdAt: Date.now() };
    const next: Conversation = {
      ...conv,
      title: conv.messages.length ? conv.title : deriveTitle(text),
      messages: [...conv.messages, message],
      updatedAt: Date.now(),
    };
    setInput('');
    await persist(next);
    await generate(next);
  };

  const regenerate = async () => {
    const msgs = [...conv.messages];
    while (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs.pop();
    if (!msgs.length) return;
    const next = { ...conv, messages: msgs };
    await persist(next);
    await generate(next);
  };

  const editFrom = async (index: number) => {
    const msg = conv.messages[index];
    if (stream) return;
    if (conv.messages.length - index > 1 && !confirm('Editing removes this message and everything after it. Continue?')) return;
    setInput(msg.content);
    await persist({ ...conv, messages: conv.messages.slice(0, index), updatedAt: Date.now() });
  };

  const removeMessage = async (index: number) => {
    await persist({ ...conv, messages: conv.messages.filter((_, i) => i !== index), updatedAt: Date.now() });
  };

  const deleteConversation = async () => {
    if (!confirm(`Delete "${conv.title}"? This cannot be undone.`)) return;
    await conversations.remove(conv.id);
    navigate('chat', { new: '1' });
  };

  const applyPrompt = (p: PromptTemplate) => {
    const v = p.versions[p.versions.length - 1];
    if (!v) return;
    void update({ system: v.system });
    setInput(v.template);
    setShowPrompts(false);
    toast(`Loaded prompt "${p.name}" v${v.version}. Fill in any {{variables}} before sending.`, 'info');
  };

  const saveAsPrompt = async () => {
    const now = Date.now();
    const p: PromptTemplate = {
      id: uid(),
      name: conv.title === 'New chat' ? 'Untitled prompt' : conv.title,
      description: `Saved from chat with ${conv.model}`,
      tags: ['from-chat'],
      versions: [{ version: 1, system: conv.system, template: input || conv.messages.find((m) => m.role === 'user')?.content || '', createdAt: now }],
      createdAt: now,
      updatedAt: now,
    };
    await prompts.put(p);
    toast('Saved to prompt library', 'success', { label: 'Open', run: () => navigate(`prompts/${p.id}`) });
  };

  const totals = useMemo(() => {
    let cost = 0;
    let tokens = 0;
    for (const m of conv.messages) {
      cost += m.costUsd ?? 0;
      tokens += (m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0);
    }
    return { cost, tokens };
  }, [conv.messages]);

  const codeInput = provider
    ? {
        provider,
        model: conv.model,
        system: conv.system,
        params: conv.params,
        messages: [
          ...conv.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
          ...(input.trim() ? [{ role: 'user' as const, content: input.trim() }] : []),
        ],
      }
    : null;

  const lastIsAssistant = conv.messages[conv.messages.length - 1]?.role === 'assistant';

  return (
    <div className="chat-main">
      <div className="chat-toolbar">
        <Button className="menu-btn" variant="ghost" iconOnly icon="menu" aria-label="Show chats" onClick={onToggleList} />
        <div style={{ minWidth: 220, flex: '0 1 320px' }}>
          <ModelPicker value={conv.model ? { providerId: conv.providerId, model: conv.model } : undefined} onChange={(ref) => void update({ providerId: ref.providerId, model: ref.model })} />
        </div>
        <Button size="sm" icon="prompt" variant={panel === 'system' ? 'primary' : 'default'} onClick={() => setPanel(panel === 'system' ? null : 'system')}>
          System{conv.system ? ' •' : ''}
        </Button>
        <Button size="sm" icon="sliders" variant={panel === 'params' ? 'primary' : 'default'} onClick={() => setPanel(panel === 'params' ? null : 'params')}>
          Parameters
        </Button>
        <Button size="sm" icon="history" onClick={() => setShowPrompts(true)}>
          Prompts
        </Button>
        <div className="flex-1" />
        <span className="small subtle hide-mobile">
          {formatCompact(totals.tokens)} tok · {formatUSD(totals.cost)}
        </span>
        <Button size="sm" variant="ghost" icon="code" disabled={!codeInput} onClick={() => setShowCode(true)}>
          Code
        </Button>
        <ExportMenu conv={conv} disabled={isDraft} />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="pin"
          disabled={isDraft}
          aria-label={conv.pinned ? 'Unpin' : 'Pin'}
          title={conv.pinned ? 'Unpin' : 'Pin'}
          onClick={() => void update({ pinned: !conv.pinned })}
        />
        <Button size="sm" variant="ghost" iconOnly icon="trash" disabled={isDraft} aria-label="Delete conversation" onClick={deleteConversation} />
      </div>

      {panel === 'system' ? (
        <div className="params-panel">
          <div className="stack sm" style={{ maxWidth: 860, margin: '0 auto' }}>
            <Field label="System prompt" hint="Instructions applied to every turn of this conversation.">
              <Textarea rows={4} value={conv.system} onChange={(e) => void update({ system: e.target.value })} placeholder="You are a concise assistant for…" />
            </Field>
            <div className="row">
              <Button size="sm" icon="plus" onClick={saveAsPrompt}>
                Save system + input as prompt
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {panel === 'params' ? <ParamsPanel conv={conv} onChange={(params) => void update({ params })} /> : null}

      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="chat-thread">
          {!conv.messages.length && !stream ? (
            <EmptyState title="Start a conversation">
              {provider?.kind === 'local'
                ? 'This model runs entirely in your browser. The first message downloads the weights (cached afterwards).'
                : provider
                  ? `Messages go directly from your browser to ${provider.name}. Nothing passes through any other server.`
                  : 'Choose a model above. Configure providers and API keys in Settings.'}
            </EmptyState>
          ) : null}
          {conv.messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              isLast={i === conv.messages.length - 1}
              busy={!!stream}
              onCopy={async () => {
                const ok = await copyText(m.content);
                toast(ok ? 'Copied' : 'Copy failed', ok ? 'success' : 'error');
              }}
              onInspect={() => setInspect(m)}
              onEdit={m.role === 'user' ? () => void editFrom(i) : undefined}
              onRegenerate={m.role === 'assistant' && i === conv.messages.length - 1 ? () => void regenerate() : undefined}
              onDelete={() => void removeMessage(i)}
            />
          ))}
          {stream ? (
            <div className="msg assistant">
              <div className="msg-head">
                <span className="msg-role">assistant</span>
                <span>{conv.model}</span>
                <span className="spinner" />
                {stream.status ? <span>{stream.status}</span> : null}
              </div>
              {stream.thinking ? (
                <details open={!stream.text}>
                  <summary>Reasoning</summary>
                  <div className="thinking">{stream.thinking}</div>
                </details>
              ) : null}
              <div className="msg-body">{stream.text ? <Markdown text={stream.text} /> : <span className="subtle">Waiting for response…</span>}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <Textarea
            value={input}
            placeholder={conv.model ? `Message ${conv.model}…  (Enter to send, Shift+Enter for a new line)` : 'Pick a model to start'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="row between">
            <span className="small subtle">
              ~{formatCompact(estimateTokens(input))} tokens in draft
              {provider?.kind === 'local' ? ' · on-device' : provider ? ` · sent to ${provider.name}` : ''}
            </span>
            <div className="row">
              {lastIsAssistant && !stream ? (
                <Button size="sm" icon="refresh" onClick={() => void regenerate()}>
                  Regenerate
                </Button>
              ) : null}
              {stream ? (
                <Button variant="danger" icon="stop" onClick={() => abortRef.current?.abort()}>
                  Stop
                </Button>
              ) : (
                <Button variant="primary" icon="send" disabled={!input.trim() || !conv.model} onClick={() => void send()}>
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {inspect ? (
        <Modal title="Inspect message" onClose={() => setInspect(null)} wide>
          <div className="stack">
            <MessageMetrics m={inspect} />
            {inspect.inspect ? (
              <>
                <h3>Request body</h3>
                <JsonView value={inspect.inspect.request} filename={`request-${inspect.id}.json`} />
                <h3>Response metadata</h3>
                <JsonView value={inspect.inspect.response ?? null} />
              </>
            ) : (
              <Notice>No raw request was stored for this message (enable “Keep raw request/response” in Settings → General).</Notice>
            )}
          </div>
        </Modal>
      ) : null}
      {showCode && codeInput ? <CodeExportDialog input={codeInput} onClose={() => setShowCode(false)} /> : null}
      {showPrompts ? <PromptPicker onPick={applyPrompt} onClose={() => setShowPrompts(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function MessageMetrics({ m }: { m: StoredMessage }) {
  const parts: string[] = [];
  if (m.latencyMs != null) parts.push(formatMs(m.latencyMs));
  if (m.firstTokenMs != null) parts.push(`first token ${formatMs(m.firstTokenMs)}`);
  if (m.usage) parts.push(`${formatCompact(m.usage.inputTokens)} → ${formatCompact(m.usage.outputTokens)} tok${m.usage.estimated ? ' (est.)' : ''}`);
  if (m.costUsd) parts.push(formatUSD(m.costUsd));
  if (m.stopReason && m.stopReason !== 'end_turn' && m.stopReason !== 'stop') parts.push(`stop: ${m.stopReason}`);
  return parts.length ? <span className="small subtle">{parts.join(' · ')}</span> : null;
}

function MessageView({
  message: m,
  isLast,
  busy,
  onCopy,
  onInspect,
  onEdit,
  onRegenerate,
  onDelete,
}: {
  message: StoredMessage;
  isLast: boolean;
  busy: boolean;
  onCopy: () => void;
  onInspect: () => void;
  onEdit?: () => void;
  onRegenerate?: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`msg ${m.role}`}>
      <div className="msg-head">
        <span className="msg-role">{m.role}</span>
        {m.model ? <span>{m.model}</span> : null}
        <MessageMetrics m={m} />
        {m.stopReason === 'refusal' ? <Badge tone="warn">refused</Badge> : null}
        {m.stopReason === 'aborted' ? <Badge>stopped</Badge> : null}
        <div className="flex-1" />
        <div className="msg-actions">
          <Button size="sm" variant="ghost" iconOnly icon="copy" title="Copy" aria-label="Copy" onClick={onCopy} />
          {m.role === 'assistant' ? <Button size="sm" variant="ghost" iconOnly icon="eye" title="Inspect" aria-label="Inspect" onClick={onInspect} /> : null}
          {onEdit ? <Button size="sm" variant="ghost" iconOnly icon="edit" title="Edit and resend" aria-label="Edit" disabled={busy} onClick={onEdit} /> : null}
          {onRegenerate ? <Button size="sm" variant="ghost" iconOnly icon="refresh" title="Regenerate" aria-label="Regenerate" disabled={busy} onClick={onRegenerate} /> : null}
          <Button size="sm" variant="ghost" iconOnly icon="trash" title="Delete message" aria-label="Delete message" disabled={busy && isLast} onClick={onDelete} />
        </div>
      </div>
      {m.thinking ? (
        <details>
          <summary>Reasoning</summary>
          <div className="thinking">{m.thinking}</div>
        </details>
      ) : null}
      {m.error ? (
        <Notice tone="err">{m.error}</Notice>
      ) : (
        <div className="msg-body">{m.role === 'user' ? m.content : m.content ? <Markdown text={m.content} /> : <span className="subtle">(empty response)</span>}</div>
      )}
    </div>
  );
}

function ParamsPanel({ conv, onChange }: { conv: Conversation; onChange: (p: ChatParams) => void }) {
  const p = conv.params;
  const provider = getProvider(conv.providerId);
  const isAnthropic = provider?.kind === 'anthropic';
  const sampling = !isAnthropic || anthropicSupportsSampling(conv.model);
  const adaptive = isAnthropic && anthropicSupportsAdaptive(conv.model);
  const set = (patch: Partial<ChatParams>) => onChange({ ...p, ...patch });
  return (
    <div className="params-panel">
      <div className="stack sm" style={{ maxWidth: 860, margin: '0 auto' }}>
        <div className="grid cols-4">
          <Field label="Temperature" hint={sampling ? 'Blank = provider default' : 'Not supported by this model'}>
            <NumberInput value={p.temperature} min={0} max={2} step={0.1} placeholder="default" onChange={(v) => set({ temperature: v })} />
          </Field>
          <Field label="Top P" hint={sampling ? 'Nucleus sampling' : 'Not supported by this model'}>
            <NumberInput value={p.topP} min={0} max={1} step={0.05} placeholder="default" onChange={(v) => set({ topP: v })} />
          </Field>
          <Field label="Max output tokens" hint={isAnthropic ? 'Default 64,000' : provider?.kind === 'local' ? 'Default 1,024' : 'Blank = provider default'}>
            <NumberInput value={p.maxTokens} min={1} step={256} placeholder="default" onChange={(v) => set({ maxTokens: v })} />
          </Field>
          <Field label="Effort" hint={isAnthropic ? (adaptive ? 'Reasoning depth vs. cost' : 'Not supported by this model') : 'reasoning_effort (reasoning models)'}>
            <Select value={p.effort ?? ''} onChange={(e) => set({ effort: (e.target.value || undefined) as Effort | undefined })}>
              <option value="">default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              {isAnthropic ? <option value="xhigh">xhigh</option> : null}
              {isAnthropic ? <option value="max">max</option> : null}
            </Select>
          </Field>
        </div>
        <div className="row">
          <Field label="Stop sequences" hint="Comma-separated">
            <Input
              value={(p.stop ?? []).join(', ')}
              onChange={(e) =>
                set({
                  stop: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Checkbox
            checked={!!p.showReasoning}
            onChange={(v) => set({ showReasoning: v })}
            label={isAnthropic ? 'Show reasoning summary (adaptive thinking)' : 'Show reasoning (when the provider streams it)'}
            disabled={isAnthropic && !adaptive}
          />
          <Button size="sm" variant="ghost" onClick={() => onChange({})}>
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExportMenu({ conv, disabled }: { conv: Conversation; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const base = `${slugify(conv.title)}-${timestampSlug()}`;
  return (
    <>
      <Button size="sm" variant="ghost" icon="download" disabled={disabled} onClick={() => setOpen(true)}>
        Export
      </Button>
      {open ? (
        <Modal title="Export conversation" onClose={() => setOpen(false)}>
          <div className="stack">
            <Button
              icon="file"
              onClick={() => {
                downloadJSON(conv, `${base}.json`);
                setOpen(false);
              }}
            >
              JSON (full fidelity, re-importable via workspace backup)
            </Button>
            <Button
              icon="file"
              onClick={() => {
                downloadText(toMarkdown(conv), `${base}.md`, 'text/markdown');
                setOpen(false);
              }}
            >
              Markdown transcript
            </Button>
            <Button
              icon="file"
              onClick={() => {
                const messages = [
                  ...(conv.system ? [{ role: 'system', content: conv.system }] : []),
                  ...conv.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })),
                ];
                downloadText(`${JSON.stringify({ messages })}\n`, `${base}.jsonl`, 'application/jsonl');
                setOpen(false);
              }}
            >
              Fine-tuning JSONL (chat “messages” format)
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function PromptPicker({ onPick, onClose }: { onPick: (p: PromptTemplate) => void; onClose: () => void }) {
  const { items } = useCollection(prompts);
  const [q, setQ] = useState('');
  const list = items.filter((p) => !q || `${p.name} ${p.description} ${p.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Insert from prompt library" onClose={onClose}>
      <div className="stack">
        <Input placeholder="Search prompts…" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.length ? (
          <div className="list card">
            {list.map((p) => (
              <button key={p.id} className="list-item" onClick={() => onPick(p)}>
                <div className="title">{p.name}</div>
                <div className="meta">
                  v{p.versions.length} · {p.description || 'No description'}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted small">
            No prompts yet. Create them on the <a href="#/prompts">Prompts</a> page.
          </p>
        )}
      </div>
    </Modal>
  );
}
