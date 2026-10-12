import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export function Button({
  variant = 'default',
  size,
  icon,
  iconOnly,
  loading,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm';
  icon?: IconName;
  iconOnly?: boolean;
  loading?: boolean;
}) {
  const classes = ['btn', variant !== 'default' ? variant : '', size ?? '', iconOnly ? 'icon' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {iconOnly ? null : children}
    </button>
  );
}

export function Field({ label, hint, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`select ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Number input that keeps an empty value as undefined. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  id,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  id?: string;
}) {
  return (
    <input
      id={id}
      className="input"
      type="number"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '') onChange(undefined);
        else {
          const n = Number(v);
          if (Number.isFinite(n)) onChange(n);
        }
      }}
    />
  );
}

export function Badge({ tone, children, title }: { tone?: 'ok' | 'warn' | 'err' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className = '', bodyClassName = 'card-body' }: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row nowrap small muted">
      <span className="spinner" />
      {label}
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Notice({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode; icon?: IconName }) {
  const name: IconName = icon ?? (tone === 'warn' || tone === 'err' ? 'alert' : tone === 'ok' ? 'check' : 'info');
  return (
    <div className={`notice ${tone}`}>
      <Icon name={name} style={{ marginTop: 2, flex: 'none' }} />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function KeyValues({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
