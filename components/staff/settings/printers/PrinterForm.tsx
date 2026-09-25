// PRN-1 — the Add/Edit printer form: name, connection (network/USB/installed)
// and paper width. Roles & copies, cut style and the cash-drawer flag used to
// live in this same form; they now have their own page sections (Ticket
// routing, Paper & cutting, Cash drawer below it) that edit a saved printer
// directly, since those are page-wide "which printer does X" questions
// rather than one printer's own identity/connection. The draft still CARRIES
// those fields (see shared.ts's Draft comment) — this form just doesn't
// render controls for them, so saving here can never reset them.

import type { DetectedPrinter, PrinterConnection } from '@/lib/desktop/bridge';
import type { Draft } from './shared';

export function PrinterForm({
  draft,
  isEdit,
  detecting,
  detectedUsb,
  detectedSystem,
  saveError,
  saving,
  onChange,
  onRunDetect,
  onCancel,
  onSave,
}: {
  draft: Draft;
  isEdit: boolean;
  detecting: boolean;
  detectedUsb: (DetectedPrinter & { connection: Extract<PrinterConnection, { kind: 'usb' }> })[];
  detectedSystem: (DetectedPrinter & { connection: Extract<PrinterConnection, { kind: 'system' }> })[];
  saveError: string | null;
  saving: boolean;
  onChange: (updater: (d: Draft) => Draft) => void;
  onRunDetect: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-6 rounded-md border border-tan bg-white p-4">
      <h3 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">
        {isEdit ? 'Edit printer' : 'Add printer'}
      </h3>

      <label className="mt-3 block text-sm">
        <span className="text-charcoal">Name</span>
        <input
          value={draft.name}
          onChange={(e) => onChange((d) => ({ ...d, name: e.target.value }))}
          placeholder="e.g. Kitchen"
          className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
        />
      </label>

      <div className="mt-3">
        <span className="mb-1 block text-sm text-charcoal">Connection</span>
        <div className="grid grid-cols-3 gap-2">
          {(['network', 'usb', 'system'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onChange((d) => ({ ...d, connKind: kind }))}
              className={`min-h-[44px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                draft.connKind === kind ? 'border-charcoal bg-charcoal text-cream' : 'border-[#e5e5e5] text-charcoal'
              }`}
            >
              {kind === 'network' ? 'Network' : kind === 'usb' ? 'USB' : 'Installed printer'}
            </button>
          ))}
        </div>
      </div>

      {draft.connKind === 'network' ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-sm">
            <span className="text-charcoal">Host / IP</span>
            <input
              value={draft.networkHost}
              onChange={(e) => onChange((d) => ({ ...d, networkHost: e.target.value }))}
              placeholder="192.168.1.50"
              className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="text-charcoal">Port</span>
            <input
              value={draft.networkPort}
              onChange={(e) => onChange((d) => ({ ...d, networkPort: e.target.value }))}
              inputMode="numeric"
              className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
            />
          </label>
        </div>
      ) : null}

      {draft.connKind === 'usb' ? (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-charcoal">Device</span>
            <button
              type="button"
              onClick={onRunDetect}
              disabled={detecting}
              className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1 text-xs font-bold text-charcoal hover:border-tan disabled:opacity-50"
            >
              {detecting ? 'Scanning…' : 'Scan for printers'}
            </button>
          </div>
          {detectedUsb.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No USB printers detected. Plug one in and scan again.</p>
          ) : (
            <select
              value={draft.usb ? `${draft.usb.vendorId}:${draft.usb.productId}:${draft.usb.serialNumber ?? ''}` : ''}
              onChange={(e) => {
                const match = detectedUsb.find(
                  (d) =>
                    `${d.connection.vendorId}:${d.connection.productId}:${d.connection.serialNumber ?? ''}` ===
                    e.target.value,
                );
                onChange((d) => ({ ...d, usb: match ? match.connection : null }));
              }}
              className="mt-2 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
            >
              <option value="">Choose a device…</option>
              {detectedUsb.map((d) => (
                <option
                  key={`${d.connection.vendorId}:${d.connection.productId}:${d.connection.serialNumber ?? ''}`}
                  value={`${d.connection.vendorId}:${d.connection.productId}:${d.connection.serialNumber ?? ''}`}
                >
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {draft.connKind === 'system' ? (
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-charcoal">Installed printer</span>
            <button
              type="button"
              onClick={onRunDetect}
              disabled={detecting}
              className="min-h-[36px] rounded-md border border-[#e5e5e5] px-3 py-1 text-xs font-bold text-charcoal hover:border-tan disabled:opacity-50"
            >
              {detecting ? 'Scanning…' : 'Scan for printers'}
            </button>
          </div>
          {detectedSystem.length === 0 ? (
            <p className="mt-2 text-xs text-muted">No installed printers detected. Scan again.</p>
          ) : (
            <select
              value={draft.systemDeviceName}
              onChange={(e) => onChange((d) => ({ ...d, systemDeviceName: e.target.value }))}
              className="mt-2 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
            >
              <option value="">Choose a printer…</option>
              {detectedSystem.map((d) => (
                <option key={d.connection.deviceName} value={d.connection.deviceName}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(['raw', 'driver'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange((d) => ({ ...d, systemMode: mode }))}
                className={`min-h-[44px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                  draft.systemMode === mode ? 'border-charcoal bg-charcoal text-cream' : 'border-[#e5e5e5] text-charcoal'
                }`}
              >
                {mode === 'raw' ? 'Raw' : 'Driver'}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">
            {draft.systemMode === 'raw'
              ? 'Raw = ESC/POS thermal, fastest, supports cut & drawer.'
              : 'Driver = any printer, prints the HTML ticket.'}
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        <span className="mb-1 block text-sm text-charcoal">Paper width</span>
        <div className="grid grid-cols-2 gap-2">
          {([58, 80] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onChange((d) => ({ ...d, paperWidthMm: w }))}
              className={`min-h-[44px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                draft.paperWidthMm === w ? 'border-charcoal bg-charcoal text-cream' : 'border-[#e5e5e5] text-charcoal'
              }`}
            >
              {w}mm
            </button>
          ))}
        </div>
      </div>

      {!isEdit ? (
        <p className="mt-4 text-xs text-muted">
          Ticket routing, cut style and the cash drawer are set up below once this printer is saved.
        </p>
      ) : null}

      {saveError ? <p className="mt-3 text-sm text-red-700">{saveError}</p> : null}

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[44px] rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal hover:border-tan"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="min-h-[44px] rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save printer'}
        </button>
      </div>
    </div>
  );
}
