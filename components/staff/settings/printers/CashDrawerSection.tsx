// PRN-1 — Cash drawer: which printer the drawer's kick port is wired
// through, and a Test open drawer button. Only one printer may drive the
// drawer (PRN-1) — enforced the same way the old per-printer toggle did:
// turning it on for one printer clears it everywhere else in the same save.

import type { PrinterConfig } from '@/lib/desktop/bridge';

export function CashDrawerSection({
  printers,
  notice,
  testing,
  onChange,
  onTest,
}: {
  printers: PrinterConfig[];
  notice: string | null;
  testing: boolean;
  onChange: (next: PrinterConfig[]) => void;
  onTest: (printer: PrinterConfig) => void;
}) {
  const current = printers.find((p) => p.drawer) ?? null;

  function selectDrawer(id: string) {
    if (!id) {
      onChange(printers.map((p) => (p.drawer ? { ...p, drawer: false } : p)));
      return;
    }
    onChange(printers.map((p) => ({ ...p, drawer: p.id === id })));
  }

  if (printers.length === 0) {
    return <p className="text-sm text-muted">Add a printer above to wire the cash drawer to it.</p>;
  }

  return (
    <div>
      <label className="block text-sm">
        <span className="text-charcoal">Printer with the cash drawer attached</span>
        <select
          value={current?.id ?? ''}
          onChange={(e) => selectDrawer(e.target.value)}
          className="mt-1 min-h-[44px] w-full max-w-xs rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
        >
          <option value="">No drawer configured</option>
          {printers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        disabled={!current || testing}
        onClick={() => current && onTest(current)}
        className="mt-3 min-h-[44px] rounded-md border border-[#e5e5e5] px-4 text-sm font-bold text-charcoal hover:border-tan disabled:opacity-50"
      >
        {testing ? 'Opening…' : 'Test open drawer'}
      </button>
      {notice ? <p className="mt-2 text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
