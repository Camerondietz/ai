import { describe, expect, it } from 'vitest';
import { checkUrl, hostMatches, isLocalHost, redactUrl, type NetPolicy } from './net';

const APP = 'https://me.github.io';
const allow: NetPolicy = { mode: 'allowlist', allowlist: ['api.openai.com', '*.huggingface.co'] };

describe('network policy', () => {
  it('matches host patterns', () => {
    expect(hostMatches('api.openai.com', 'api.openai.com')).toBe(true);
    expect(hostMatches('evil-api.openai.com', 'api.openai.com')).toBe(false);
    expect(hostMatches('cdn-lfs.huggingface.co', '*.huggingface.co')).toBe(true);
    expect(hostMatches('huggingface.co', '*.huggingface.co')).toBe(false);
    expect(hostMatches('huggingface.co.evil.com', '*.huggingface.co')).toBe(false);
  });

  it('detects local hosts', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('[::1]')).toBe(true);
    expect(isLocalHost('app.localhost')).toBe(true);
    expect(isLocalHost('localhost.evil.com')).toBe(false);
  });

  it('enforces the allowlist', () => {
    expect(checkUrl(new URL('https://api.openai.com/v1/models'), allow, APP).allowed).toBe(true);
    expect(checkUrl(new URL('https://tracker.example.com/x'), allow, APP).allowed).toBe(false);
    expect(checkUrl(new URL('https://me.github.io/ort/x.wasm'), allow, APP).allowed).toBe(true);
    expect(checkUrl(new URL('http://localhost:11434/v1/chat/completions'), allow, APP).allowed).toBe(true);
  });

  it('blocks plain http to remote hosts even in open mode', () => {
    const open: NetPolicy = { mode: 'open', allowlist: [] };
    expect(checkUrl(new URL('http://example.com'), open, APP).allowed).toBe(false);
    expect(checkUrl(new URL('https://example.com'), open, APP).allowed).toBe(true);
  });

  it('local-only mode blocks every remote host', () => {
    const local: NetPolicy = { mode: 'local-only', allowlist: ['*'] };
    expect(checkUrl(new URL('https://api.openai.com'), local, APP).allowed).toBe(false);
    expect(checkUrl(new URL('http://127.0.0.1:1234/v1/models'), local, APP).allowed).toBe(true);
  });

  it('redacts query strings', () => {
    expect(redactUrl(new URL('https://h.co/api/models?search=secret'))).toBe('https://h.co/api/models?…');
    expect(redactUrl(new URL('https://h.co/a'))).toBe('https://h.co/a');
  });
});
