import { dismissToast, useToasts } from '../state/toast';
import { Button } from './ui';

export function Toasts() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div className="msg">{t.message}</div>
          {t.action ? (
            <Button
              size="sm"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" iconOnly icon="x" aria-label="Dismiss" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
