// PRN-1 — Ticket routing: a compact table of which printer(s) print
// Receipt / KOT / Token, and how many copies. Writes straight to the saved
// printer list via `onChange` (which the orchestrator saves through the same
// bridge.printers.save() call everything else uses — no new IPC, just a
// different place in the UI to trigger it from). A role may sit on several
// printers (kitchen KOT + a second expo KOT, say), so each cell is its own
// on/off toggle rather than a single-select per role.

import type { PrinterConfig, PrinterRole } from '@/lib/desktop/bridge';
import { ROLES, ROLE_LABELS } from './shared';

export function TicketRoutingTable({
  printers,
  savingId,
  onChange,
}: {
  printers: PrinterConfig[];
  savingId: string | null;
  /** Takes an updater, not a finished list — SaveQueue (lib/staff/saveQueue.ts)
   * applies it to the latest ACTUALLY-enqueued list, not this component's
   * possibly-stale `printers` prop, so two quick toggles never both derive
   * from the same snapshot and clobber each other. */
  onChange: (updater: (prev: PrinterConfig[]) => PrinterConfig[]) => void;
}) {
  if (printers.length === 0) {
    return <p className="text-sm text-muted">Add a printer above, then assign it to Receipt, KOT or Token here.</p>;
  }

  function toggle(printerId: string, role: PrinterRole) {
    onChange((prev) =>
      prev.map((p) => {
        if (p.id !== printerId) return p;
        const has = p.roles.includes(role);
        const roles = has ? p.roles.filter((r) => r !== role) : [...p.roles, role];
        const copies = { ...p.copies };
        if (has) delete copies[role];
        else if (copies[role] === undefined) copies[role] = 1;
        return { ...p, roles, copies };
      }),
    );
  }

  function setCopies(printerId: string, role: PrinterRole, value: number) {
    const clamped = Math.min(5, Math.max(1, Math.trunc(value) || 1));
    onChange((prev) =>
      prev.map((p) => (p.id === printerId ? { ...p, copies: { ...p.copies, [role]: clamped } } : p)),
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-bold uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-2">
              Printer
            </th>
            {ROLES.map((role) => (
              <th key={role} scope="col" className="py-2 px-2 text-center">
                {ROLE_LABELS[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {printers.map((p) => (
            <tr key={p.id} className="border-b border-line last:border-0">
              <th scope="row" className="py-2 pr-2 text-left font-bold text-charcoal">
                {p.name}
              </th>
              {ROLES.map((role) => {
                const on = p.roles.includes(role);
                return (
                  <td key={role} className="py-2 px-2 text-center align-top">
                    <div className="flex flex-col items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggle(p.id, role)}
                        disabled={savingId === p.id}
                        aria-pressed={on}
                        aria-label={`${ROLE_LABELS[role]} on ${p.name}`}
                        className={`min-h-[44px] min-w-[44px] rounded-md border px-3 text-xs font-bold transition-colors disabled:opacity-50 ${
                          on ? 'border-charcoal bg-charcoal text-cream' : 'border-[#e5e5e5] text-charcoal'
                        }`}
                      >
                        {on ? 'On' : 'Off'}
                      </button>
                      {on ? (
                        <label className="flex items-center gap-1 text-[10px] text-muted">
                          copies
                          <input
                            type="number"
                            min={1}
                            max={5}
                            value={p.copies[role] ?? 1}
                            onChange={(e) => setCopies(p.id, role, Number(e.target.value))}
                            className="w-10 rounded border border-[#e5e5e5] px-1 py-0.5 text-center text-xs tabular-nums focus:border-tan focus:outline-none"
                          />
                        </label>
                      ) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
