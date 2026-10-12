import { describe, expect, it } from 'vitest';
import { generateCode, toPython } from './codegen';
import type { ProviderConfig } from '../state/types';

const anthropic: ProviderConfig = {
  id: 'anthropic',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  secretRef: 'provider:anthropic',
  models: [],
  enabled: true,
  options: { refusalFallback: true },
};

const groq: ProviderConfig = {
  id: 'groq',
  name: 'Groq',
  kind: 'openai',
  baseUrl: 'https://api.groq.com/openai/v1',
  secretRef: 'provider:groq',
  models: [],
  enabled: true,
  preset: 'groq',
  options: { maxTokensField: 'max_tokens' },
};

const input = {
  model: 'claude-opus-5-5',
  system: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Hi $HOME' }],
  params: { temperature: 0.2, maxTokens: 500 },
};

describe('code generation', () => {
  it('renders Python literals', () => {
    expect(toPython({ a: true, b: null, c: [1, 'x'] })).toBe('{\n    "a": True,\n    "b": None,\n    "c": [\n        1,\n        "x",\n    ],\n}');
  });

  it('uses env vars for keys and adds the fallback beta for supported Claude models', () => {
    const curl = generateCode({ ...input, provider: anthropic }, 'curl');
    expect(curl).toContain('$ANTHROPIC_API_KEY');
    expect(curl).toContain('anthropic-beta: server-side-fallback-2026-07-01');
    expect(curl).toContain('"fallbacks": "default"');
    // Sampling params are not sent to models that reject them.
    expect(curl).not.toContain('temperature');
    const py = generateCode({ ...input, provider: anthropic }, 'python');
    expect(py).toContain('client.beta.messages.stream(');
    expect(py).toContain('max_tokens=500,');
  });

  it('generates OpenAI-compatible snippets', () => {
    const js = generateCode({ ...input, model: 'llama-3.3-70b', provider: groq }, 'javascript');
    expect(js).toContain('process.env.GROQ_API_KEY');
    expect(js).toContain('"temperature": 0.2');
    expect(js).not.toContain('"stream"');
    const curl = generateCode({ ...input, model: 'llama-3.3-70b', provider: groq }, 'curl');
    expect(curl).toContain("<<'EOF'");
  });
});
