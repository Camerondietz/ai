/**
 * "Copy as code": turn the current request into a runnable curl / Python /
 * JavaScript snippet. API keys are always referenced through environment
 * variables, never embedded.
 */
import { anthropicFallbackBeta, buildAnthropicParams } from '../providers/anthropic';
import { buildOpenAIBody } from '../providers/openai';
import { joinUrl } from '../providers/types';
import type { ChatMessage, ChatParams, ProviderConfig } from '../state/types';

export type CodeLang = 'curl' | 'python' | 'javascript';

export interface CodeInput {
  provider: ProviderConfig;
  model: string;
  system?: string;
  messages: ChatMessage[];
  params: ChatParams;
}

export function envVarFor(provider: ProviderConfig): string {
  if (provider.kind === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider.secretRef === 'hf:token') return 'HF_TOKEN';
  const base = (provider.preset ?? provider.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${base}_API_KEY`;
}

/** Render a JSON value as a Python literal. */
export function toPython(value: unknown, indent = 0): string {
  const pad = (n: number) => '    '.repeat(n);
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad(indent + 1) + toPython(v, indent + 1)).join(',\n')},\n${pad(indent)}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad(indent + 1)}${JSON.stringify(k)}: ${toPython(v, indent + 1)}`).join(',\n')},\n${pad(indent)}}`;
}

function pythonKwargs(obj: Record<string, unknown>, indent: number): string {
  const pad = '    '.repeat(indent);
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${pad}${k}=${toPython(v, indent)},`)
    .join('\n');
}

function indentJSON(value: unknown, spaces: number): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${' '.repeat(spaces)}`);
}

function anthropicCode(input: CodeInput, lang: CodeLang): string {
  const params = buildAnthropicParams(input);
  const beta = anthropicFallbackBeta(input.provider, input.model);
  const base = input.provider.baseUrl || 'https://api.anthropic.com';
  if (lang === 'curl') {
    const body = beta ? { ...params, fallbacks: 'default', stream: true } : { ...params, stream: true };
    return [
      `curl ${joinUrl(base, 'v1/messages')} \\`,
      '  -H "x-api-key: $ANTHROPIC_API_KEY" \\',
      '  -H "anthropic-version: 2023-06-01" \\',
      ...(beta ? [`  -H "anthropic-beta: ${beta}" \\`] : []),
      '  -H "content-type: application/json" \\',
      "  -d @- <<'EOF'",
      JSON.stringify(body, null, 2),
      'EOF',
    ].join('\n');
  }
  if (lang === 'python') {
    const kwargs = beta ? { ...params, betas: [beta], fallbacks: 'default' } : params;
    return [
      'import anthropic',
      '',
      'client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY',
      '',
      `with client.${beta ? 'beta.' : ''}messages.stream(`,
      pythonKwargs(kwargs, 1),
      ') as stream:',
      '    for text in stream.text_stream:',
      '        print(text, end="", flush=True)',
      '    message = stream.get_final_message()',
      '',
      'print("\\n", message.usage)',
    ].join('\n');
  }
  const body = beta ? { ...params, betas: [beta], fallbacks: 'default' } : params;
  return [
    'import Anthropic from "@anthropic-ai/sdk";',
    '',
    'const client = new Anthropic(); // reads ANTHROPIC_API_KEY',
    '',
    `const stream = client.${beta ? 'beta.' : ''}messages`,
    `  .stream(${indentJSON(body, 2)})`,
    '  .on("text", (text) => process.stdout.write(text));',
    '',
    'const message = await stream.finalMessage();',
    'console.log("\\n", message.usage);',
  ].join('\n');
}

function openAICode(input: CodeInput, lang: CodeLang): string {
  const body = buildOpenAIBody(input);
  delete body.stream;
  delete body.stream_options;
  const envVar = envVarFor(input.provider);
  const needsKey = !!input.provider.secretRef;
  const url = joinUrl(input.provider.baseUrl, 'chat/completions');
  if (lang === 'curl') {
    return [
      `curl ${url} \\`,
      ...(needsKey ? [`  -H "Authorization: Bearer $${envVar}" \\`] : []),
      '  -H "Content-Type: application/json" \\',
      "  -d @- <<'EOF'",
      JSON.stringify(body, null, 2),
      'EOF',
    ].join('\n');
  }
  if (lang === 'python') {
    return [
      'import os',
      'from openai import OpenAI',
      '',
      'client = OpenAI(',
      `    base_url=${JSON.stringify(input.provider.baseUrl)},`,
      `    api_key=${needsKey ? `os.environ[${JSON.stringify(envVar)}]` : '"not-needed"'},`,
      ')',
      '',
      'response = client.chat.completions.create(',
      pythonKwargs(body, 1),
      ')',
      'print(response.choices[0].message.content)',
      'print(response.usage)',
    ].join('\n');
  }
  return [
    `const res = await fetch(${JSON.stringify(url)}, {`,
    '  method: "POST",',
    '  headers: {',
    '    "Content-Type": "application/json",',
    ...(needsKey ? [`    Authorization: \`Bearer \${process.env.${envVar}}\`,`] : []),
    '  },',
    `  body: JSON.stringify(${indentJSON(body, 2)}),`,
    '});',
    'if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);',
    'const data = await res.json();',
    'console.log(data.choices[0].message.content);',
    'console.log(data.usage);',
  ].join('\n');
}

function localCode(input: CodeInput, lang: CodeLang): string {
  const messages = [...(input.system ? [{ role: 'system', content: input.system }] : []), ...input.messages];
  const maxNew = input.params.maxTokens ?? 1024;
  if (lang === 'python') {
    return [
      '# Same model family with the Python transformers library (original, non-ONNX weights).',
      'from transformers import pipeline',
      '',
      `generator = pipeline("text-generation", model=${JSON.stringify(input.model.replace(/-ONNX$/, ''))})`,
      `messages = ${toPython(messages)}`,
      `out = generator(messages, max_new_tokens=${maxNew})`,
      'print(out[0]["generated_text"][-1]["content"])',
    ].join('\n');
  }
  if (lang === 'curl') return '# In-browser models have no HTTP endpoint. Use the JavaScript tab.';
  return [
    'import { pipeline, TextStreamer } from "@huggingface/transformers";',
    '',
    `const generator = await pipeline("text-generation", ${JSON.stringify(input.model)}, { dtype: "q4", device: "webgpu" });`,
    `const messages = ${indentJSON(messages, 0)};`,
    'const out = await generator(messages, {',
    `  max_new_tokens: ${maxNew},`,
    '  streamer: new TextStreamer(generator.tokenizer, { skip_prompt: true }),',
    '});',
    'console.log(out[0].generated_text.at(-1).content);',
  ].join('\n');
}

export function generateCode(input: CodeInput, lang: CodeLang): string {
  switch (input.provider.kind) {
    case 'anthropic':
      return anthropicCode(input, lang);
    case 'local':
      return localCode(input, lang);
    default:
      return openAICode(input, lang);
  }
}
