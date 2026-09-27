import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { keyLabel } from './keys';

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="keys">
      {keys.map((k) => (
        <kbd key={k}>{keyLabel(k)}</kbd>
      ))}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children, actions }: { icon?: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="empty-icon">
          <Icon size={16} strokeWidth={1.75} />
        </span>
      )}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({ value, max = 100 }: { value?: number | null; max?: number }) {
  const indeterminate = value === undefined || value === null;
  return (
    <div className={`progress ${indeterminate ? 'indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={indeterminate ? undefined : value}>
      <span style={{ width: indeterminate ? undefined : `${Math.max(2, Math.min(100, (value / max) * 100))}%` }} />
    </div>
  );
}
