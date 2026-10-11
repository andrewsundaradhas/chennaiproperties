import { useEffect, useId, useRef, type ReactNode } from 'react';
import { humanise } from '../lib/api';
import type { AvailabilityStatus, LeadStatus } from '../lib/types';

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path d="M8 23V14l8-6 8 6v9h-5v-6h-6v6z" fill="var(--bg)" />
      <circle cx="23.5" cy="9" r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  available: 'badge-ok',
  pending_confirmation: 'badge-warn',
  unavailable: 'badge-danger',
  deactivated: '',
  new: 'badge-info',
  contacted: 'badge-primary',
  visit_requested: 'badge-warn',
  qualified: 'badge-ok',
  closed: '',
  spam: 'badge-danger',
};

const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: 'Pending confirmation',
  visit_requested: 'Visit requested',
};

export function StatusBadge({ status }: { status: AvailabilityStatus | LeadStatus | string }) {
  const label = STATUS_LABEL[status] ?? humanise(status).replace(/^./, (c) => c.toUpperCase());
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{label}</span>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  const label = channel === 'telegram' ? 'Telegram' : channel === 'whatsapp' ? 'WhatsApp' : 'Web chat';
  return <span className={`badge ${channel === 'telegram' ? 'badge-info' : ''}`}>{label}</span>;
}

export function DemoBadge() {
  return (
    <span className="badge badge-demo" title="Sample listing for demonstration — not real inventory">
      Sample data
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <span className="error" id={`${id}-err`}>
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert alert-error row" role="alert">
      <span className="spacer">{error}</span>
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Accessible modal dialog: focus moves in, Escape closes, focus returns on close. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog panel panel-pad stack" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="row">
          <h2 id={titleId} className="spacer">
            {title}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
