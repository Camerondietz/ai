// Copies the ONNX Runtime WebAssembly files into public/ort so in-browser
// inference is served from this site instead of a public CDN (the
// Transformers.js default). Runs before `dev` and `build`.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  join('node_modules', 'onnxruntime-web', 'dist'),
  join('node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-web', 'dist'),
];
const files = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

const source = candidates.find((dir) => existsSync(dir));
if (!source) {
  console.warn('[copy-ort] onnxruntime-web not found. Run `npm install`. In-browser inference will be unavailable.');
  process.exit(0);
}

const dest = join('public', 'ort');
mkdirSync(dest, { recursive: true });
let copied = 0;
for (const file of files) {
  const from = join(source, file);
  if (existsSync(from)) {
    cpSync(from, join(dest, file));
    copied++;
  } else {
    console.warn(`[copy-ort] ${file} not found in ${source}`);
  }
}
console.log(`[copy-ort] ${copied}/${files.length} runtime files copied to ${dest}`);
