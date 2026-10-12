import { useMemo, useState, type ReactNode } from 'react';
import { formatUSD } from '../lib/format';
import { href, navigate, useRoute } from '../router';
import { usage } from '../state/collections';
import { useCollection } from '../lib/collection';
import { useSettings } from '../state/settings';
import { monthStart, spendSince } from '../state/usage';
import { lockVault, useVault } from '../state/vault';
import { NAV_ITEMS } from './CommandPalette';
import { Icon } from './icons';
import { Button } from './ui';
import { CreateVaultDialog, UnlockDialog } from './VaultDialogs';

function VaultPill() {
  const vault = useVault();
  const [dialog, setDialog] = useState<'unlock' | 'create' | null>(null);
  const label =
    vault.status === 'unlocked'
      ? 'Vault unlocked'
      : vault.status === 'locked'
        ? 'Vault locked'
        : vault.status === 'session'
          ? 'Keys: session only'
          : 'No keys';
  const tone = vault.status === 'unlocked' ? 'ok' : vault.status === 'locked' ? 'warn' : vault.status === 'session' ? 'warn' : '';
  return (
    <>
      <button
        className="pill-btn"
        title={
          vault.status === 'session'
            ? 'API keys are held in memory only and vanish on reload. Click to create an encrypted vault.'
            : vault.status === 'unlocked'
              ? 'Click to lock the vault now'
              : vault.status === 'locked'
                ? 'Click to unlock'
                : 'Add API keys in Settings → Providers'
        }
        onClick={() => {
          if (vault.status === 'unlocked') lockVault();
          else if (vault.status === 'locked') setDialog('unlock');
          else if (vault.status === 'session') setDialog('create');
          else navigate('settings', { tab: 'providers' });
        }}
      >
        <Icon name={vault.status === 'unlocked' ? 'unlock' : 'lock'} size={14} />
        <span className="hide-mobile">{label}</span>
        <span className={`dot ${tone}`} />
      </button>
      {dialog === 'unlock' ? <UnlockDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'create' ? <CreateVaultDialog onClose={() => setDialog(null)} /> : null}
    </>
  );
}

function NetworkPill() {
  const { net } = useSettings();
  const label = net.mode === 'local-only' ? 'Local only' : net.mode === 'allowlist' ? `Allowlist (${net.allowlist.length})` : 'Open network';
  const tone = net.mode === 'open' ? 'warn' : 'ok';
  return (
    <a className="pill-btn" href={href('settings', { tab: 'security' })} title="Network policy for all outbound requests" style={{ textDecoration: 'none' }}>
      <Icon name="shield" size={14} />
      <span className="hide-mobile">{label}</span>
      <span className={`dot ${tone}`} />
    </a>
  );
}

function BudgetPill() {
  const { budget } = useSettings();
  const { items } = useCollection(usage);
  const spent = useMemo(() => spendSince(items, monthStart()), [items]);
  const ratio = budget.monthlyUsd > 0 ? spent / budget.monthlyUsd : 0;
  const tone = ratio >= 1 ? 'err' : ratio >= 0.8 ? 'warn' : 'ok';
  return (
    <a className="pill-btn hide-mobile" href={href('dashboard')} title="Spend this month vs. budget" style={{ textDecoration: 'none' }}>
      {formatUSD(spent)}
      {budget.monthlyUsd > 0 ? <span className="subtle">/ {formatUSD(budget.monthlyUsd)}</span> : null}
      <span className={`dot ${tone}`} />
    </a>
  );
}

export function Layout({ children, onOpenPalette }: { children: ReactNode; onOpenPalette: () => void }) {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const section = route.segments[0] ?? 'dashboard';
  const groups = [...new Set(NAV_ITEMS.map((n) => n.group))];
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  return (
    <div className="shell">
      {menuOpen ? <div className="scrim" onClick={() => setMenuOpen(false)} /> : null}
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">A</span>
          AI Workbench
        </div>
        <nav className="nav" onClick={() => setMenuOpen(false)}>
          {groups.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-label">{g}</div>
              {NAV_ITEMS.filter((n) => n.group === g).map((n) => (
                <a key={n.path} href={href(n.path)} className={section === n.path ? 'active' : ''}>
                  <Icon name={n.icon} />
                  {n.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>Local-first · no telemetry</span>
          <span>
            <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> <kbd>K</kbd> commands
          </span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Button className="menu-btn" variant="ghost" iconOnly icon="menu" aria-label="Open menu" onClick={() => setMenuOpen(true)} />
          <button className="pill-btn" onClick={onOpenPalette} aria-label="Open command palette">
            <Icon name="search" size={14} />
            <span className="hide-mobile">Search commands…</span>
            <kbd className="hide-mobile">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <div className="spacer" />
          <BudgetPill />
          <NetworkPill />
          <VaultPill />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
