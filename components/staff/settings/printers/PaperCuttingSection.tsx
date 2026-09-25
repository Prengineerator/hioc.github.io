// PRN-1 — Paper & cutting: whether each raw-capable printer cuts after
// printing, and which cut style it uses, with the same help text the old
// per-printer form showed. Driver-mode system printers can't take a cut
// command at all (PRN-4), so they're left out entirely rather than shown
// disabled — same rule printerIsRawCapable() has always enforced.

import type { CutMode, PrinterConfig } from '@/lib/desktop/bridge';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { CUT_MODES, CUT_MODE_HINTS, CUT_MODE_LABELS } from '@/lib/print/testTicket';
import { printerIsRawCapable } from './shared';

export function PaperCuttingSection({
  printers,
  savingId,
  onChange,
}: {
  printers: PrinterConfig[];
  savingId: string | null;
  onChange: (next: PrinterConfig[]) => void;
}) {
  const eligible = printers.filter(printerIsRawCapable);

  if (eligible.length === 0) {
    return (
      <p className="text-sm text-muted">
        No printers here can cut automatically yet — driver-mode printers cut through their own driver, if it
        supports it.
      </p>
    );
  }

  function setCut(id: string, cut: boolean) {
    onChange(printers.map((p) => (p.id === id ? { ...p, cut } : p)));
  }

  function setCutMode(id: string, cutMode: CutMode) {
    onChange(printers.map((p) => (p.id === id ? { ...p, cutMode } : p)));
  }

  return (
    <ul className="flex flex-col gap-4">
      {eligible.map((p) => {
        const cutMode = p.cutMode ?? 'standard';
        return (
          <li key={p.id} className="rounded-md border border-[#e5e5e5] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-charcoal">{p.name}</span>
              <ToggleSwitch
                checked={p.cut}
                onChange={(v) => setCut(p.id, v)}
                label={`Cut after print — ${p.name}`}
              />
            </div>
            {p.cut ? (
              <div className="mt-3">
                <select
                  value={cutMode}
                  disabled={savingId === p.id}
                  onChange={(e) => setCutMode(p.id, e.target.value as CutMode)}
                  className="min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none disabled:opacity-50"
                >
                  {CUT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {CUT_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted">{CUT_MODE_HINTS[cutMode]}</p>
                <p className="mt-1 text-xs text-muted">
                  If the paper doesn’t cut, try the next style and press Test cut again.
                </p>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
