/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content Security Policy for the production build.
 *
 * GitHub Pages cannot set response headers, so the policy ships as a <meta> tag.
 * It is only injected at build time because Vite's dev server relies on inline
 * scripts for hot reload.
 *
 * - script-src: only our own bundle. 'wasm-unsafe-eval' is required to compile
 *   the ONNX Runtime WebAssembly used for in-browser inference.
 * - connect-src: HTTPS anywhere plus plain HTTP to localhost (Ollama, LM Studio,
 *   vLLM). The app's own network guard (src/lib/net.ts) enforces the finer,
 *   user-editable allowlist on top of this.
 * - img-src: no remote images, so model cards and chat output cannot be used
 *   for tracking pixels.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: blob: data: http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "manifest-src 'self'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'inject-content-security-policy',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!-- CSP -->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any GitHub Pages sub-path.
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? 'dev'),
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
