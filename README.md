# AI Workbench

A local-first, frontend-only web app for day-to-day AI operations and AI engineering work.
It runs entirely in your browser: there is no backend, no account, and no telemetry. Your data
lives in your browser's IndexedDB, your API keys live in an encrypted vault, and every network
request passes through a policy you control.

Deploys as a static site (GitHub Pages works out of the box).

## Features

| Area | What you can do |
| --- | --- |
| **Chat** | Streaming chat with any configured model. System prompts, parameters, reasoning display, per-message latency / tokens / cost, raw request/response inspector, “copy as code” (Python, JavaScript, curl), export to JSON / Markdown / fine-tuning JSONL. |
| **Compare** | Send one prompt to up to 6 models side by side; rate outputs; save results as a dataset. |
| **Prompts** | Versioned prompt library with `{{variables}}`, test runs, version history, import/export. |
| **Datasets** | Import CSV/TSV/JSON/JSONL or rows from any Hugging Face dataset; edit; export as CSV/JSONL/JSON or fine-tuning formats (chat messages, Alpaca, prompt/completion); push to the Hub. |
| **Evaluations** | Run a prompt template over a dataset across several models with bounded concurrency. Scorers: exact match, contains, token F1, valid JSON, regex, LLM-as-judge. Per-model summary, cost estimate before you run, resumable runs, CSV/JSON export, push results to the Hub. |
| **Models** | Inspect `.safetensors`, `.gguf` and `.onnx` files (parameters, dtypes, tensors, metadata, ops) locally or **directly from Hugging Face via HTTP range requests without downloading weights**. SHA-256 verification. Model registry with model cards. VRAM / KV-cache memory estimator. |
| **Hugging Face** | Search models and datasets, read model cards, list files, and hand off: inspect weights, run in browser, chat through HF Inference Providers, import dataset rows. |
| **Local Lab** | Run 13 Transformers.js tasks on-device (WebGPU or WebAssembly): chat, embeddings, classification, zero-shot, NER, QA, summarization, translation, fill-mask, image classification, object detection, captioning, speech-to-text. Import a model folder from disk to run it fully offline. |
| **Tools** | Tokenizer playground (side-by-side tokenizers, exact Claude counts via API), local semantic search over a dataset (the retrieval half of RAG), JSON/JSONL/CSV converter, cost planner. |
| **Operations** | Dashboard with spend per day, top models, latency and error rate; monthly budget with optional hard stop; usage ledger; live network audit log. |

### Providers

- **Anthropic (Claude)** via the official `@anthropic-ai/sdk`, including adaptive thinking summaries, effort control and server-side refusal fallback.
- **Any OpenAI-compatible API**: OpenAI, Hugging Face Inference Providers, Google Gemini, OpenRouter, Groq, Mistral, and local servers (Ollama, LM Studio, vLLM, llama.cpp, LiteLLM, TGI).
- **In-browser models** via Transformers.js (no key, no server).

## Security and privacy model

- **No backend.** Requests go straight from your browser to the provider you chose.
- **Encrypted key vault.** API keys are encrypted at rest with AES-256-GCM using a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations). The derived key is non-extractable and lives in memory only while unlocked; the vault auto-locks after inactivity. Without a vault, keys are held in memory only and vanish on reload.
- **Network policy.** All requests, including from libraries and the inference worker, are checked against an allowlist (default), a local-only air-gap mode, or open mode. Plain HTTP to remote hosts is always blocked. Every request is logged (metadata only) in Activity.
- **Content Security Policy** in production builds: only bundled scripts, HTTPS-only connections, no remote images, no plugins, no form posts.
- **Safe rendering.** Model output is rendered by a small Markdown renderer that never injects HTML; links are limited to http(s)/mailto with `noopener noreferrer`.
- **No cookies or Referer** are sent to third-party APIs. The app refuses to run inside frames.
- **Self-hosted runtime.** The ONNX Runtime WebAssembly is served from your own site, not a CDN.
- **Backups** can be encrypted with a passphrase; the vault is only ever exported in its encrypted form.

See [SECURITY.md](SECURITY.md) for the threat model and its limits.

## Quick start

Requirements: [Node.js](https://nodejs.org) 20.19+ or 22+.

```bash
npm install
npm run dev
```

Open the printed URL (usually http://localhost:5173), then:

1. **Settings → Providers & keys**: add an API key (or use Ollama / the in-browser model with no key).
2. Click the lock button (top right) to **create an encrypted vault** so keys persist.
3. Try **Chat**, then import a dataset and run an **Evaluation**.

Other scripts:

```bash
npm test          # unit tests (parsers, crypto, network policy, scorers, renderer)
npm run check     # TypeScript type check
npm run build     # production build in dist/
npm run preview   # serve the production build locally
```

## Deploy to GitHub Pages

1. Push this repository to GitHub (commit `package-lock.json` after your first `npm install`).
2. In the repository, open **Settings → Pages** and set **Source: GitHub Actions**.
3. Push to `main`. The `Deploy to GitHub Pages` workflow builds and publishes `dist/`.

The build uses relative paths and hash routing, so it works under `https://<user>.github.io/<repo>/` without configuration.
CI (`.github/workflows/ci.yml`) runs the type check, tests, build and `npm audit` on every push and pull request. Dependabot keeps dependencies and actions current.

## Connecting local model servers

Browsers only let a web page call a local server that allows it (CORS):

- **Ollama**: start it with your site's origin allowed, e.g. `OLLAMA_ORIGINS=https://<user>.github.io ollama serve` (or `http://localhost:5173` for development).
- **LM Studio**: enable CORS in the local server settings.
- **vLLM**: `vllm serve <model> --allowed-origins '["https://<user>.github.io"]'`.

Your browser may also ask for permission to access devices on your local network.

## Interoperability

- **Hugging Face Hub**: search, model cards, file trees, gated/private repos with your token, safetensors/GGUF/ONNX inspection via range requests, dataset rows via the dataset viewer API, and publishing datasets / eval results / model cards with the official `@huggingface/hub` client (repos are created private by default).
- **Formats in/out**: CSV, TSV, JSON, JSONL; OpenAI-style chat JSONL, Alpaca and prompt/completion for fine-tuning; Markdown transcripts; full-workspace JSON backups; prompt and model-registry exports.
- **Code export**: every chat request can be copied as Python (official SDKs), JavaScript or curl to move from experimentation to production.

## Project structure

```
src/
  lib/          framework-free logic: crypto, network guard, IndexedDB, SSE, CSV/JSONL,
                safetensors / GGUF / ONNX parsers, scorers, code generation, HF client
  providers/    Anthropic (SDK), OpenAI-compatible (fetch + SSE), in-browser (worker)
  workers/      Transformers.js inference worker + main-thread client
  state/        settings, vault, collections, usage/budget, eval runner, backups
  components/   UI primitives, Markdown renderer, charts, tables, dialogs
  pages/        one file per page
scripts/copy-ort.mjs   self-hosts the ONNX Runtime WebAssembly
```

## Learning with this codebase

Each module is small and readable on purpose:

- `lib/sse.ts`, `providers/openai.ts`: how streaming LLM APIs work on the wire.
- `providers/anthropic.ts`, `lib/codegen.ts`: the Messages API, thinking/effort, and SDK usage.
- `lib/safetensors.ts`, `lib/gguf.ts`, `lib/onnx.ts`: what is actually inside model files.
- `lib/memory.ts`: why context length and grouped-query attention dominate inference memory.
- `lib/scoring.ts`, `state/evalRunner.ts`: how evaluation harnesses and LLM judges work.
- `pages/Tools.tsx` (semantic search): embeddings and cosine similarity, the core of RAG.
- `lib/crypto.ts`, `lib/net.ts`: practical client-side security.

## Limitations

- Frontend-only means API keys are used in the browser. Use restricted, per-project keys with spending limits; see [SECURITY.md](SECURITY.md).
- Some providers do not allow browser (CORS) requests; those need a gateway such as LiteLLM.
- Training/fine-tuning runs are out of scope; the app prepares data and evaluates results.
- In-browser models are limited by device memory; WebGPU is strongly recommended for LLMs.
