'use client';

// Small building blocks shared by every marketing tab. The repo's own components
// (Modal, Button, Input, Select, ToggleSwitch, DataTable, Spinner, Card) are
// reused as they are; this file only adds what the dashboard needs and they
// don't: a status pill, a notice, a KPI tile, a segmented control, a side
// drawer and the loading / error / migration-missing gate every fetch goes through.

import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { useDialogBehavior } from '@/components/ui/useDialogBehavior';
import type { ApiFailure } from './api';
import type { Tone } from './format';
import type { ApiResource } from './hooks';

// ---------------------------------------------------------------------------
// Pill, notice, panel, KPI, progress
// ---------------------------------------------------------------------------

const PILL_TONES: Record<Tone, string> = {
  good: 'bg-green-100 text-green-900',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-red-100 text-red-800',
  neutral: 'bg-[#f2efe9] text-charcoal',
};

/** A status label. The words carry the meaning; the colour only reinforces it. */
export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL_TONES[tone]}`}>
      {children}
    </span>
  );
}

type NoticeTone = 'info' | 'warn' | 'bad' | 'good';

const NOTICE_TONES: Record<NoticeTone, { box: string; glyph: string; label: string }> = {
  info: { box: 'border-line bg-surface text-charcoal', glyph: 'i', label: 'Note' },
  warn: { box: 'border-amber-300 bg-amber-50 text-amber-900', glyph: '!', label: 'Heads up' },
  bad: { box: 'border-red-200 bg-red-50 text-red-800', glyph: '!', label: 'Problem' },
  good: { box: 'border-green-200 bg-green-50 text-green-900', glyph: '✓', label: 'Good' },
};

/** A banner. Always has a glyph and a screen-reader label, so it never relies on colour alone. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  const t = NOTICE_TONES[tone];
  return (
    <div role={role} className={`flex items-start gap-3 rounded-md border p-4 text-sm ${t.box}`}>
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold">
        {t.glyph}
      </span>
      <div className="min-w-0 flex-1">
        <span className="sr-only">{t.label}: </span>
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
        {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/** Card with a heading and an optional right-hand action, in the owner pages' card style. */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-line bg-cream p-5 shadow-sm ${className}`}>
      {title || action ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal">{title}</h2> : null}
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Kpi({ label, value, hint, children }: { label: string; value: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 break-words font-mono text-xl font-bold tabular-nums text-charcoal sm:text-2xl">{value}</p>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/** A used-of-total bar. The fill turns amber near the limit and red over it, and the label always says the numbers. */
export function ProgressBar({
  value,
  max,
  label,
  valueText,
  tone,
}: {
  value: number;
  max: number;
  label: string;
  /** Spoken value, e.g. "₹1,200 of ₹1,000". aria-valuenow can't exceed the max, so an overrun needs words. */
  valueText?: string;
  tone?: 'auto' | 'plain';
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : value > 0 ? 1 : 0;
  const over = max > 0 ? value > max : value > 0;
  const fill = tone === 'plain' ? 'bg-tan' : over ? 'bg-red-600' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-tan';
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(max, 0)}
      aria-valuenow={Math.min(Math.max(max, 0), Math.max(0, Math.round(value)))}
      aria-valuetext={valueText}
      className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line"
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Pick one of a few options. Buttons with aria-pressed (a group of toggles, not a radio list), 44px tall for a thumb. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-line bg-cream">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={
              'min-h-[44px] min-w-[64px] px-4 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tan disabled:opacity-50 ' +
              (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')
            }
          >
            {active ? <span aria-hidden="true">✓ </span> : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Help text under a field. */
export function Help({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p id={id} className="text-xs text-muted">
      {children}
    </p>
  );
}

/** A checkbox with a real 44px tap row. */
export function CheckRow({ checked, onChange, children }: { checked: boolean; onChange: (next: boolean) => void; children: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-charcoal">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[#8a6446]" />
      <span>{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * "Are you sure?" for anything that spends money or messages customers. Reuses
 * the shared Modal (Escape, focus trap, scroll lock). The confirm button says
 * what will happen ("Send 162 messages"), never a bare "OK".
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Go back',
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onCancel}
      title={title}
      size="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-charcoal">
        {children}
        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 font-semibold text-red-800">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** A panel that slides in from the right (a bottom-to-top full sheet on a phone). Same keyboard behaviour as Modal. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, onClose, panelRef);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 animate-fade-in bg-charcoal/50" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-3xl animate-fade-in flex-col bg-cream shadow-elevated outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold text-charcoal">
              {title}
            </h2>
            {subtitle ? <div className="mt-0.5 text-sm text-muted">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            data-dialog-close
            onClick={onClose}
            className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-charcoal hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
          >
            &times;
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// The gate every fetch goes through: loading → error / migration missing → content
// ---------------------------------------------------------------------------

export function MigrationMissing() {
  return (
    <Notice
      tone="warn"
      role="alert"
      title="Marketing needs a one-time database update"
      action={
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          I have applied it, reload
        </Button>
      }
    >
      Apply <code className="rounded bg-white px-1 py-0.5 font-mono text-xs">supabase/2026-10-marketing-agent.sql</code> in Supabase → SQL editor, then reload.
    </Notice>
  );
}

export function ErrorNote({ error, onRetry }: { error: ApiFailure; onRetry?: () => void }) {
  if (error.kind === 'migration_missing') return <MigrationMissing />;
  return (
    <Notice
      tone="bad"
      role="alert"
      title="This did not load"
      action={
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {error.message}
    </Notice>
  );
}

/** Renders the right thing for a fetch's state, so no tab can forget loading, errors or the missing-migration case. */
export function ResourceGate<T>({
  resource,
  label,
  children,
}: {
  resource: ApiResource<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  const { state, reload } = resource;
  if (state.status === 'loading') return <Spinner label={label} />;
  if (state.status === 'error') return <ErrorNote error={state.error} onRetry={reload} />;
  return <>{children(state.data)}</>;
}

/** A tab-sized heading + intro line. */
export function TabIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="text-xl font-bold text-charcoal">{title}</h2>
      {children ? <p className="mt-1 max-w-2xl text-sm text-muted">{children}</p> : null}
    </div>
  );
}
