import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installFetchGuard } from './lib/net';
import { evals } from './state/collections';
import { initSettings } from './state/settings';
import { initVault } from './state/vault';
import './styles.css';

function fatal(message: string) {
  const root = document.getElementById('root')!;
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'lock-screen';
  const p = document.createElement('p');
  p.textContent = message;
  box.appendChild(p);
  root.appendChild(box);
}

async function boot() {
  // Clickjacking defense: frame-ancestors cannot be set from a <meta> CSP.
  if (window.top !== window.self) {
    fatal('For your security, AI Workbench cannot run inside a frame. Open it directly.');
    return;
  }

  // All outbound requests go through the network policy from here on.
  installFetchGuard();

  if (!('indexedDB' in window)) {
    fatal('This browser does not provide IndexedDB storage (private mode?). AI Workbench needs it to keep your data locally.');
    return;
  }

  try {
    await initSettings();
    await initVault();
  } catch (err) {
    fatal(`Could not open local storage: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Eval runs that were in progress when the tab closed cannot resume.
  void evals.all().then((runs) =>
    Promise.all(runs.filter((r) => r.status === 'running').map((r) => evals.put({ ...r, status: 'interrupted' }))),
  );

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
