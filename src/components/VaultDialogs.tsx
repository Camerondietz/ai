import { useState } from 'react';
import { passphraseBits } from '../lib/crypto';
import { toast } from '../state/toast';
import { createVault, MIN_PASSPHRASE_LENGTH, unlockVault } from '../state/vault';
import { Modal } from './Modal';
import { Button, Field, Input, Notice } from './ui';

export function UnlockDialog({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await unlockVault(passphrase);
      toast('Vault unlocked', 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Unlock vault"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="unlock" loading={busy} disabled={!passphrase} onClick={submit}>
            Unlock
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="muted small" style={{ margin: 0 }}>
          Your API keys are encrypted on this device with AES-256-GCM. Decryption happens locally; the passphrase is never stored or sent anywhere.
        </p>
        <Field label="Passphrase">
          <Input type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        {error ? <Notice tone="err">{error}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function strengthLabel(bits: number): { label: string; tone: 'err' | 'warn' | 'ok' } {
  if (bits < 50) return { label: 'weak', tone: 'err' };
  if (bits < 75) return { label: 'fair', tone: 'warn' };
  return { label: 'strong', tone: 'ok' };
}

export function CreateVaultDialog({ onClose }: { onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bits = passphraseBits(passphrase);
  const strength = strengthLabel(bits);
  const valid = passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === confirm;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      await createVault(passphrase);
      toast('Encrypted vault created. Keys now persist across reloads.', 'success');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create encrypted vault"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="lock" loading={busy} disabled={!valid} onClick={submit}>
            Create vault
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Notice>
          Keys are encrypted with a key derived from this passphrase (PBKDF2-SHA256, 600k iterations) and stored only in this browser.
          <strong> If you forget the passphrase, the keys cannot be recovered</strong>; you would re-enter them.
        </Notice>
        <Field label="Passphrase" hint={passphrase ? `Strength: ${strength.label} (~${bits} bits)` : `At least ${MIN_PASSPHRASE_LENGTH} characters. A few random words works well.`}>
          <Input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </Field>
        <Field label="Confirm passphrase" hint={confirm && confirm !== passphrase ? 'Does not match' : undefined}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error ? <Notice tone="err">{error}</Notice> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
