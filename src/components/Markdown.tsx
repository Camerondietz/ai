/**
 * Safe Markdown renderer. Model output is parsed into React elements; nothing
 * is ever injected as HTML, so responses cannot run script. Links are limited
 * to http(s)/mailto and open with noopener/noreferrer. Remote images are shown
 * as links instead of being loaded (no tracking pixels).
 */
import { createElement, memo, useState, type ReactNode } from 'react';
import { copyText } from '../lib/download';
import { Button } from './ui';

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang || 'text'}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? 'check' : 'copy'}
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;

export function parseInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const key = () => `${keyPrefix}-${out.length}`;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
      if (m) {
        flush();
        out.push(<code key={key()}>{m[2].replace(/^ (.*) $/, '$1')}</code>);
        i += m[0].length;
        continue;
      }
    }

    if (ch === '!' && text[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[2]}>
            [image: {m[1] || 'untitled'}]
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === '[') {
      const m = /^\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[2]}>
            {parseInline(m[1], key())}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if (ch === '<') {
      const m = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[1]}>
            {m[1]}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s(]/.test(text[i - 1]))) {
      const m = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/i.exec(rest);
      if (m) {
        flush();
        out.push(
          <Link key={key()} href={m[0]}>
            {m[0]}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const re = ch === '*' ? /^\*\*(?=\S)([\s\S]*?\S)\*\*/ : /^__(?=\S)([\s\S]*?\S)__(?!\w)/;
      const m = re.exec(rest);
      if (m && (ch === '*' || i === 0 || !/\w/.test(text[i - 1]))) {
        flush();
        out.push(<strong key={key()}>{parseInline(m[1], key())}</strong>);
        i += m[0].length;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const re = ch === '*' ? /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/ : /^_(?=\S)([\s\S]*?\S)_(?!\w)/;
      const m = re.exec(rest);
      if (m && (ch === '*' || i === 0 || !/\w/.test(text[i - 1]))) {
        flush();
        out.push(<em key={key()}>{parseInline(m[1], key())}</em>);
        i += m[0].length;
        continue;
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (m) {
        flush();
        out.push(<del key={key()}>{parseInline(m[1], key())}</del>);
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isBlockStart(line: string, next?: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s*>/.test(line) ||
    LIST_RE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next))
  );
}

export function renderBlocks(src: string, kp = 'b'): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `${kp}-${out.length}`;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input while streaming)
      out.push(<CodeBlock key={key()} lang={fence[2]} code={body.join('\n')} />);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(createElement(`h${heading[1].length}`, { key: key() }, parseInline(heading[2], key())));
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*> ?/, ''));
      out.push(<blockquote key={key()}>{renderBlocks(quoted.join('\n'), key())}</blockquote>);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c): 'center' | 'right' | undefined =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const k = key();
      out.push(
        <table key={k}>
          <thead>
            <tr>
              {header.map((h, c) => (
                <th key={c} style={aligns[c] ? { textAlign: aligns[c] } : undefined}>
                  {parseInline(h, `${k}-h${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {header.map((_, c) => (
                  <td key={c} style={aligns[c] ? { textAlign: aligns[c] } : undefined}>
                    {parseInline(r[c] ?? '', `${k}-${ri}-${c}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const lm = LIST_RE.exec(line);
    if (lm) {
      const baseIndent = lm[1].length;
      const ordered = /\d/.test(lm[2]);
      const strip = baseIndent + lm[2].length + 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_RE.exec(l);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          items.push([m[3]]);
          i++;
          continue;
        }
        if (!l.trim()) {
          const next = lines[i + 1];
          if (next !== undefined && next.trim() && indentOf(next) > baseIndent) {
            items[items.length - 1].push('');
            i++;
            continue;
          }
          const nm = next !== undefined ? LIST_RE.exec(next) : null;
          if (nm && nm[1].length === baseIndent && /\d/.test(nm[2]) === ordered) {
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > baseIndent) {
          items[items.length - 1].push(l.slice(Math.min(indentOf(l), strip)));
          i++;
          continue;
        }
        if (!isBlockStart(l, lines[i + 1])) {
          items[items.length - 1].push(l.trim());
          i++;
          continue;
        }
        break;
      }
      const k = key();
      const children = items.map((itemLines, idx) => {
        let first = itemLines[0];
        let task: ReactNode = null;
        const t = /^\[([ xX])\]\s+/.exec(first);
        if (t) {
          task = <span aria-hidden="true">{t[1] === ' ' ? '☐ ' : '☑ '}</span>;
          first = first.slice(t[0].length);
        }
        return (
          <li key={idx}>
            {task}
            {renderBlocks([first, ...itemLines.slice(1)].join('\n'), `${k}-${idx}`)}
          </li>
        );
      });
      const start = ordered ? parseInt(lm[2], 10) : undefined;
      out.push(
        ordered ? (
          <ol key={k} start={start !== 1 ? start : undefined}>
            {children}
          </ol>
        ) : (
          <ul key={k}>{children}</ul>
        ),
      );
      continue;
    }

    // Paragraph: gather lines until a blank line or another block starts.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++]);
    const k = key();
    const content: ReactNode[] = [];
    para.forEach((p, idx) => {
      if (idx > 0) content.push(<br key={`${k}-br${idx}`} />);
      content.push(...parseInline(p.replace(/\s+$/, ''), `${k}-${idx}`));
    });
    out.push(<p key={k}>{content}</p>);
  }
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(text)}</div>;
});
