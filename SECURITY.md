# Security

## What this app protects against

| Threat | Mitigation |
| --- | --- |
| Someone reading your browser storage (stolen laptop backup, shared profile) | API keys are encrypted at rest (AES-256-GCM, PBKDF2-SHA256 with 600k iterations, random salt and IV). Without a vault, keys are never written to disk. |
| Leaving the app unlocked | Auto-lock after configurable inactivity; one-click lock in the top bar. |
| Data leaving to unexpected servers | App-level network policy (allowlist / local-only / open) applied to every request, including third-party libraries and the inference worker; HTTPS-only CSP; metadata-only audit log. |
| Malicious model output (prompt-injected HTML/JS, tracking pixels) | No HTML rendering of model output; remote images are never loaded; links restricted to http(s)/mailto with `noopener noreferrer`. |
| Injected scripts | Production CSP allows only the app's own bundled scripts (`script-src 'self' 'wasm-unsafe-eval'`); no CDNs, no inline scripts. |
| Clickjacking | The app refuses to render inside a frame. |
| Credential leakage to the wrong host | Each key is attached only to its own provider's requests; the Hugging Face token only to the configured Hub hosts; no cookies or Referer are sent cross-origin. |
| Spreadsheet formula injection in exports | CSV exports neutralize cells starting with `=`, `+`, `-`, `@`. |
| Runaway spend | Monthly budget with optional hard stop, cost estimates before evaluations, per-request cost tracking. |

## What it cannot protect against

- **A compromised browser or device.** Malicious extensions, malware, or anyone with access to your unlocked session can read keys in memory.
- **Supply-chain compromise of a dependency.** Dependencies are few and from established publishers, versions are locked by `package-lock.json`, and Dependabot + `npm audit` run in CI. Review dependency updates before merging.
- **Provider-side data handling.** Prompts sent to a cloud provider are subject to that provider's retention and privacy terms. For sensitive data use local-only mode with in-browser models or a local server.
- **A forgotten vault passphrase.** It cannot be recovered; re-enter your keys.
- **Hosting-level headers.** GitHub Pages cannot set HTTP security headers, so the CSP is delivered via `<meta>` (which cannot express `frame-ancestors`; the frame check covers that). Hosting on a platform that supports headers lets you add HSTS, `frame-ancestors`, COOP/COEP (which also enables multi-threaded WebAssembly).

## Recommendations

1. Use **restricted, per-project API keys** with spending limits in each provider's console.
2. Create the **encrypted vault** and keep auto-lock on.
3. Keep the network policy on **allowlist**; use **local-only** for sensitive work.
4. Use **fine-grained Hugging Face tokens** scoped to the repositories you need.
5. Encrypt **workspace backups** with a passphrase, and store them as carefully as the data inside.
6. Deploy from **your own fork**, so you control exactly what code runs.

## Reporting a vulnerability

Please open a private security advisory on this repository (GitHub → Security → Advisories → Report a vulnerability) rather than a public issue.
