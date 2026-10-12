import { useState } from 'react';
import { generateCode, type CodeInput, type CodeLang } from '../lib/codegen';
import { CodeBlock } from './Markdown';
import { Modal } from './Modal';
import { Notice, Tabs } from './ui';

export function CodeExportDialog({ input, onClose }: { input: CodeInput; onClose: () => void }) {
  const [lang, setLang] = useState<CodeLang>('python');
  const code = generateCode(input, lang);
  return (
    <Modal title="Copy as code" onClose={onClose} wide>
      <div className="stack">
        <Notice>
          Reproduce this request outside the app. Keys are read from environment variables; nothing secret is included.
        </Notice>
        <Tabs
          tabs={[
            { id: 'python', label: 'Python' },
            { id: 'javascript', label: 'JavaScript' },
            { id: 'curl', label: 'curl' },
          ]}
          value={lang}
          onChange={setLang}
        />
        <CodeBlock code={code} lang={lang === 'curl' ? 'bash' : lang} />
      </div>
    </Modal>
  );
}
