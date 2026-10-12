import { useEffect, useState } from 'react';
import { whoAmI } from '../lib/hf';
import { pushToHub } from '../lib/hfPush';
import { HF_TOKEN_SECRET } from '../providers/presets';
import { href } from '../router';
import { toast } from '../state/toast';
import { hasSecret, useVault } from '../state/vault';
import { Modal } from './Modal';
import { Button, Checkbox, Field, Input, Notice } from './ui';

export function PushToHubDialog({
  type,
  defaultName,
  describe,
  buildFiles,
  onClose,
}: {
  type: 'dataset' | 'model';
  defaultName: string;
  /** What will be uploaded, shown to the user before they confirm */
  describe: string;
  buildFiles: () => Promise<{ path: string; content: Blob }[]>;
  onClose: () => void;
}) {
  useVault();
  const hasToken = hasSecret(HF_TOKEN_SECRET);
  const [repo, setRepo] = useState(defaultName);
  const [isPrivate, setPrivate] = useState(true);
  const [create, setCreate] = useState(true);
  const [message, setMessage] = useState(`Upload from AI Workbench`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!hasToken || repo.includes('/')) return;
    whoAmI()
      .then((me) => setRepo((r) => (r.includes('/') ? r : `${me.name}/${r}`)))
      .catch(() => undefined);
  }, [hasToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = async () => {
    setBusy(true);
    setError('');
    try {
      const files = await buildFiles();
      const url = await pushToHub({ repo, type, private: isPrivate, files, commitTitle: message, createIfMissing: create });
      setDone(url);
      toast('Pushed to Hugging Face', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Push ${type} to Hugging Face`}
      onClose={onClose}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" icon="upload" loading={busy} disabled={!hasToken || !repo.includes('/')} onClick={push}>
              Push
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {!hasToken ? (
          <Notice tone="warn">
            No Hugging Face token available. Add one with write permission in <a href={href('settings', { tab: 'huggingface' })} onClick={onClose}>Settings → Hugging Face</a>.
          </Notice>
        ) : null}
        <Notice>
          This uploads data off your device: <strong>{describe}</strong>. Review it before pushing, especially for business data.
        </Notice>
        <Field label="Repository" hint="username/name or organization/name">
          <Input value={repo} onChange={(e) => setRepo(e.target.value.trim())} placeholder="your-name/my-dataset" />
        </Field>
        <Field label="Commit message">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <Checkbox checked={create} onChange={setCreate} label="Create the repository if it doesn't exist" />
        <Checkbox checked={isPrivate} onChange={setPrivate} label="Private (only applies when creating)" />
        {error ? <Notice tone="err">{error}</Notice> : null}
        {done ? (
          <Notice tone="ok">
            Done:{' '}
            <a href={done} target="_blank" rel="noopener noreferrer">
              {done}
            </a>
          </Notice>
        ) : null}
      </div>
    </Modal>
  );
}
