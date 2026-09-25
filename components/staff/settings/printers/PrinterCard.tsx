// PRN-1 — one printer card in the Printers sub-section: connection, paper
// width, a live status dot, and Test print / Test cut. Unchanged behaviour
// from the original PrinterSettings.tsx card — Edit/Delete and the test
// actions still call the exact same handlers, just via props now that the
// list rendering lives in its own component.

import type { PrinterConfig, PrinterHealth, PrinterStatus } from '@/lib/desktop/bridge';
import { HEALTH_DOT, HEALTH_LABELS, ROLE_LABELS, connectionSummary, printerIsRawCapable } from './shared';

export function PrinterCard({
  printer,
  status,
  notice,
  deleting,
  saving,
  onEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
  onTestPrint,
  onTestCut,
}: {
  printer: PrinterConfig;
  status?: PrinterStatus;
  notice?: string;
  deleting: boolean;
  saving: boolean;
  onEdit: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onTestPrint: () => void;
  onTestCut: () => void;
}) {
  const health: PrinterHealth = status?.health ?? 'unknown';

  return (
    <li className="rounded-md border border-[#e5e5e5] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-full ${HEALTH_DOT[health]}`} />
            <span className="text-sm font-bold text-charcoal">{printer.name}</span>
            {printer.drawer ? (
              <span className="rounded-md bg-[#f6efe9] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-tan-dark">
                Drawer
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-muted">{connectionSummary(printer.connection)}</p>
          <p className="text-xs text-muted">
            {printer.paperWidthMm}mm ·{' '}
            {printer.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'No roles assigned'}
            {status?.detail ? ` · ${status.detail}` : ` · ${HEALTH_LABELS[health]}`}
          </p>
        </div>
        {!deleting ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onStartDelete}
              className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-red-700 hover:border-red-400"
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-charcoal">Delete {printer.name}?</span>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={saving}
              className="min-h-[36px] rounded-md bg-red-700 px-3 py-1.5 text-xs font-bold text-cream hover:bg-red-800 disabled:opacity-50"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onTestPrint}
          className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
        >
          Test print
        </button>
        {printerIsRawCapable(printer) ? (
          <button
            type="button"
            onClick={onTestCut}
            className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
          >
            Test cut
          </button>
        ) : null}
        {notice ? <span className="text-xs text-muted">{notice}</span> : null}
      </div>
    </li>
  );
}
