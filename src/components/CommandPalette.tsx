import { useEffect, useMemo, useState } from 'react';
import { navigate } from '../router';
import { updateSettings, getSettings } from '../state/settings';
import { lockVault } from '../state/vault';
import { Icon, type IconName } from './icons';

export interface Command {
  id: string;
  label: string;
  icon: IconName;
  hint?: string;
  run: () => void;
}

export const NAV_ITEMS: { path: string; label: string; icon: IconName; group: string }[] = [
  { path: 'dashboard', label: 'Dashboard', icon: 'home', group: 'Workspace' },
  { path: 'chat', label: 'Chat', icon: 'chat', group: 'Workspace' },
  { path: 'compare', label: 'Compare', icon: 'columns', group: 'Workspace' },
  { path: 'prompts', label: 'Prompts', icon: 'prompt', group: 'Build' },
  { path: 'datasets', label: 'Datasets', icon: 'table', group: 'Build' },
  { path: 'evals', label: 'Evaluations', icon: 'beaker', group: 'Build' },
  { path: 'models', label: 'Models', icon: 'cpu', group: 'Models' },
  { path: 'hub', label: 'Hugging Face', icon: 'globe', group: 'Models' },
  { path: 'lab', label: 'Local Lab', icon: 'zap', group: 'Models' },
  { path: 'tools', label: 'Tools', icon: 'wrench', group: 'Models' },
  { path: 'activity', label: 'Activity', icon: 'activity', group: 'System' },
  { path: 'settings', label: 'Settings', icon: 'settings', group: 'System' },
];

function buildCommands(): Command[] {
  const nav: Command[] = NAV_ITEMS.map((n) => ({
    id: `go:${n.path}`,
    label: `Go to ${n.label}`,
    icon: n.icon,
    run: () => navigate(n.path),
  }));
  return [
    { id: 'new-chat', label: 'New chat', icon: 'plus', hint: 'Chat', run: () => navigate('chat', { new: '1' }) },
    { id: 'new-eval', label: 'New evaluation', icon: 'beaker', run: () => navigate('evals', { new: '1' }) },
    { id: 'inspect', label: 'Inspect a model file', icon: 'cpu', run: () => navigate('models', { tab: 'inspect' }) },
    { id: 'hub-search', label: 'Search Hugging Face', icon: 'search', run: () => navigate('hub') },
    { id: 'lock', label: 'Lock vault', icon: 'lock', run: () => lockVault() },
    {
      id: 'theme',
      label: 'Toggle dark / light theme',
      icon: 'sparkles',
      run: () => {
        const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
        updateSettings({ theme: dark ? 'light' : 'dark' });
      },
    },
    {
      id: 'local-only',
      label: getSettings().net.mode === 'local-only' ? 'Leave local-only network mode' : 'Switch to local-only network mode',
      icon: 'shield',
      run: () => updateSettings((s) => ({ ...s, net: { ...s.net, mode: s.net.mode === 'local-only' ? 'allowlist' : 'local-only' } })),
    },
    { id: 'backup', label: 'Back up workspace', icon: 'download', run: () => navigate('settings', { tab: 'data' }) },
    ...nav,
  ];
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useMemo(buildCommands, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const words = q.split(/\s+/);
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="input"
          autoFocus
          placeholder="Type a command or page…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') run(filtered[active]);
          }}
        />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <button key={c.id} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => run(c)}>
              <Icon name={c.icon} />
              <span className="flex-1">{c.label}</span>
              {c.hint ? <span className="subtle small">{c.hint}</span> : null}
            </button>
          ))}
          {!filtered.length ? <div className="empty small">No matching commands</div> : null}
        </div>
      </div>
    </div>
  );
}
