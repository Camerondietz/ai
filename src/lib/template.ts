/**
 * Prompt templates use {{variable}} placeholders. Dotted names look up nested
 * values ({{meta.source}}) when no exact key exists.
 */
const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) seen.add(m[1]);
  return [...seen];
}

function lookup(vars: Record<string, unknown>, name: string): unknown {
  if (name in vars) return vars[name];
  let cur: unknown = vars;
  for (const part of name.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

export function renderTemplate(template: string, vars: Record<string, unknown>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(VAR_RE, (whole, name: string) => {
    const value = lookup(vars, name);
    if (value === undefined) {
      missing.add(name);
      return whole;
    }
    return stringify(value);
  });
  return { text, missing: [...missing] };
}
