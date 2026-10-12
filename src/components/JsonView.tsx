import { useMemo } from 'react';
import { copyText, downloadJSON } from '../lib/download';
import { toast } from '../state/toast';
import { Button } from './ui';

export function JsonView({ value, filename, maxHeight = 420 }: { value: unknown; filename?: string; maxHeight?: number }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? 'undefined';
    } catch {
      return String(value);
    }
  }, [value]);
  return (
    <div className="stack sm">
      <div className="row">
        <Button
          size="sm"
          icon="copy"
          onClick={async () => {
            const ok = await copyText(text);
            toast(ok ? 'Copied JSON' : 'Copy failed', ok ? 'success' : 'error');
          }}
        >
          Copy
        </Button>
        {filename ? (
          <Button size="sm" icon="download" onClick={() => downloadJSON(value, filename)}>
            Download
          </Button>
        ) : null}
      </div>
      <pre className="plain mono" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}
