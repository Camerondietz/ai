import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown renderer', () => {
  it('never emits raw HTML from the input', () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops unsafe link protocols', () => {
    const html = render('[click](javascript:alert(1)) [ok](https://example.com)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('does not load remote images', () => {
    const html = render('![chart](https://tracker.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[image: chart]');
  });

  it('renders common structures', () => {
    const html = render('# Title\n\n- **bold** and `code`\n- item 2\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|--:|\n| 1 | 2 |');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('print(1)');
    expect(html).toContain('<table>');
    expect(html).toContain('text-align:right');
  });
});
