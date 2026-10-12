import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { Layout } from './components/Layout';
import { Toasts } from './components/Toasts';
import { Spinner } from './components/ui';
import { useRoute } from './router';
import { useSettings } from './state/settings';
import { toast } from './state/toast';
import { lockVault, vaultStore } from './state/vault';

/** Code-split each page so the initial bundle stays small. */
function page(loader: () => Promise<unknown>, name: string) {
  return lazy(async () => ({ default: ((await loader()) as Record<string, ComponentType>)[name] }));
}

const pages: Record<string, ReturnType<typeof page>> = {
  dashboard: page(() => import('./pages/Dashboard'), 'DashboardPage'),
  chat: page(() => import('./pages/Chat'), 'ChatPage'),
  compare: page(() => import('./pages/Compare'), 'ComparePage'),
  prompts: page(() => import('./pages/Prompts'), 'PromptsPage'),
  datasets: page(() => import('./pages/Datasets'), 'DatasetsPage'),
  evals: page(() => import('./pages/Evals'), 'EvalsPage'),
  models: page(() => import('./pages/Models'), 'ModelsPage'),
  hub: page(() => import('./pages/Hub'), 'HubPage'),
  lab: page(() => import('./pages/LocalLab'), 'LocalLabPage'),
  tools: page(() => import('./pages/Tools'), 'ToolsPage'),
  activity: page(() => import('./pages/Activity'), 'ActivityPage'),
  settings: page(() => import('./pages/Settings'), 'SettingsPage'),
};

/** Lock the vault after N idle minutes. */
function useAutoLock(minutes: number) {
  useEffect(() => {
    if (!minutes) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(() => {
      if (vaultStore.get().status === 'unlocked' && Date.now() - last > minutes * 60_000) {
        lockVault();
        toast(`Vault locked after ${minutes} minutes of inactivity`, 'info');
      }
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [minutes]);
}

export function App() {
  const route = useRoute();
  const settings = useSettings();
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useAutoLock(settings.autoLockMinutes);

  const Page = pages[route.segments[0] ?? 'dashboard'] ?? pages.dashboard;

  return (
    <>
      <Layout onOpenPalette={() => setPalette(true)}>
        <Suspense
          fallback={
            <div className="page">
              <Spinner label="Loading…" />
            </div>
          }
        >
          <Page />
        </Suspense>
      </Layout>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      <Toasts />
    </>
  );
}
