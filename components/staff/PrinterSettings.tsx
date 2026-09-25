'use client';

// PRN-1 — the printer settings screen. Desktop-only: printer config is a
// physical fact of this counter machine (which USB port, which IP), so it's
// read and written entirely through `window.hiocDesktop` (lib/desktop/bridge)
// and never touches the server (D7-6, PRN-1 "Stored locally"). In a plain
// browser tab there is nothing to configure, so NoBridgePanel below explains
// why and points at the HIOC POS desktop app instead.
//
// The bridge check is done after mount (not during the first render) so the
// server-rendered HTML and the browser's first paint agree before hydration:
// SSR has no `window` at all, and even in the desktop app the preload's
// `window.hiocDesktop` may not be the very first thing React sees. Same
// pattern as the store-open badge in StaffHeader.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { buttonVariants } from '@/components/ui/Button';
import { SurfaceLink } from '@/components/SurfaceLink';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type {
  CutMode,
  DetectedPrinter,
  HiocDesktopBridge,
  PrinterConfig,
  PrinterConnection,
  PrinterHealth,
  PrinterRole,
  PrinterStatus,
} from '@/lib/desktop/bridge';
import { renderEscPos } from '@/lib/print/escpos';
import {
  CUT_MODES,
  CUT_MODE_HINTS,
  CUT_MODE_LABELS,
  cutTestTicketDoc,
  testTicketDoc,
} from '@/lib/print/testTicket';

const ROLES: PrinterRole[] = ['kot', 'receipt', 'token'];
const ROLE_LABELS: Record<PrinterRole, string> = { kot: 'KOT', receipt: 'Receipt', token: 'Token' };

const HEALTH_LABELS: Record<PrinterHealth, string> = {
  ok: 'Online',
  paper_near_end: 'Paper low',
  paper_out: 'Out of paper',
  cover_open: 'Cover open',
  offline: 'Offline',
  error: 'Error',
  unknown: 'Status unknown',
};

const HEALTH_DOT: Record<PrinterHealth, string> = {
  ok: 'bg-green-500',
  paper_near_end: 'bg-yellow-500',
  paper_out: 'bg-red-500',
  cover_open: 'bg-red-500',
  offline: 'bg-red-500',
  error: 'bg-red-500',
  unknown: 'bg-[#c9c2b4]',
};

const STATUS_POLL_MS = 5000;

/** network and usb are always raw ESC/POS; system is raw only in 'raw' mode —
 * mirrors `isRawCapable` in lib/desktop/printExecutor.ts, for a saved config
 * rather than a draft. */
function printerIsRawCapable(p: PrinterConfig): boolean {
  return p.connection.kind !== 'system' || p.connection.mode === 'raw';
}

/** Everything the Add/Edit panel needs, in input-friendly (string) form. */
interface Draft {
  id: string;
  name: string;
  connKind: PrinterConnection['kind'];
  networkHost: string;
  networkPort: string;
  usb: Extract<PrinterConnection, { kind: 'usb' }> | null;
  systemDeviceName: string;
  systemMode: 'raw' | 'driver';
  paperWidthMm: 58 | 80;
  roles: PrinterRole[];
  copies: Partial<Record<PrinterRole, number>>;
  cut: boolean;
  cutMode: CutMode;
  drawer: boolean;
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `printer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function blankDraft(): Draft {
  return {
    id: newId(),
    name: '',
    connKind: 'network',
    networkHost: '',
    networkPort: '9100',
    usb: null,
    systemDeviceName: '',
    systemMode: 'raw',
    paperWidthMm: 80,
    roles: [],
    copies: {},
    cut: true,
    cutMode: 'standard',
    drawer: false,
  };
}

function draftFromPrinter(p: PrinterConfig): Draft {
  return {
    id: p.id,
    name: p.name,
    connKind: p.connection.kind,
    networkHost: p.connection.kind === 'network' ? p.connection.host : '',
    networkPort: p.connection.kind === 'network' ? String(p.connection.port) : '9100',
    usb: p.connection.kind === 'usb' ? p.connection : null,
    systemDeviceName: p.connection.kind === 'system' ? p.connection.deviceName : '',
    systemMode: p.connection.kind === 'system' ? p.connection.mode : 'raw',
    paperWidthMm: p.paperWidthMm,
    roles: [...p.roles],
    copies: { ...p.copies },
    cut: p.cut,
    cutMode: p.cutMode ?? 'standard',
    drawer: p.drawer,
  };
}

/** Whether this draft's connection can take raw ESC/POS bytes (PRN-4). */
function isRawCapable(draft: Pick<Draft, 'connKind' | 'systemMode'>): boolean {
  return draft.connKind !== 'system' || draft.systemMode === 'raw';
}

function draftError(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give this printer a name.';
  if (draft.connKind === 'network') {
    if (!draft.networkHost.trim()) return 'Enter the printer’s IP address.';
    const port = Number(draft.networkPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535.';
  } else if (draft.connKind === 'usb') {
    if (!draft.usb) return 'Pick a USB device — scan for printers first.';
  } else if (draft.connKind === 'system') {
    if (!draft.systemDeviceName.trim()) return 'Pick an installed printer — scan for printers first.';
  }
  return null;
}

function draftToConnection(draft: Draft): PrinterConnection {
  if (draft.connKind === 'network') {
    return { kind: 'network', host: draft.networkHost.trim(), port: Number(draft.networkPort) || 9100 };
  }
  if (draft.connKind === 'usb' && draft.usb) return draft.usb;
  return { kind: 'system', deviceName: draft.systemDeviceName, mode: draft.systemMode };
}

function draftToConfig(draft: Draft): PrinterConfig {
  const roles = draft.roles;
  const copies: Partial<Record<PrinterRole, number>> = {};
  for (const role of roles) {
    const n = draft.copies[role];
    if (n !== undefined) copies[role] = n;
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    connection: draftToConnection(draft),
    paperWidthMm: draft.paperWidthMm,
    roles,
    copies,
    cut: isRawCapable(draft) ? draft.cut : false,
    cutMode: draft.cutMode,
    drawer: draft.drawer,
  };
}

function connectionSummary(c: PrinterConnection): string {
  if (c.kind === 'network') return `Network — ${c.host}:${c.port}`;
  if (c.kind === 'usb') return `USB — ${c.serialNumber ?? `${c.vendorId}:${c.productId}`}`;
  return `Installed — ${c.deviceName} (${c.mode === 'raw' ? 'raw' : 'driver'})`;
}

export function PrinterSettings() {
  const [bridge, setBridge] = useState<HiocDesktopBridge | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setBridge(getDesktopBridge());
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (!bridge) return <NoBridgePanel />;

  return <PrinterSettingsInner bridge={bridge} />;
}

const DESKTOP_APP_RELEASES_URL = 'https://github.com/Prengineerator/hioc.github.io/releases/latest';

/**
 * Shown instead of the settings form in a plain browser tab, where there is
 * no `window.hiocDesktop` bridge at all (PRN-1). A browser genuinely cannot
 * do either job here — it can't enumerate or choose OS printers for raw
 * ESC/POS, and it has no way to pulse the cash drawer's kick port — so this
 * explains that plainly and points staff at the one thing that fixes it:
 * installing the HIOC POS desktop app on this counter machine.
 */
function NoBridgePanel() {
  return (
    <section className="mx-auto max-w-lg px-4 py-12">
      <h1 className="text-2xl font-bold text-charcoal">Printing and the cash drawer need the HIOC POS app</h1>
      <p className="mt-3 text-sm text-muted">
        A browser tab can’t choose which printer to use or send raw commands to it, and it has no way to
        pulse the cash drawer’s kick port. The HIOC POS desktop app runs on this counter machine and can do
        both.
      </p>

      <a
        href={DESKTOP_APP_RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ className: 'mt-5' })}
      >
        Download HIOC POS for Windows
      </a>

      <ol className="mt-6 flex flex-col gap-2 text-sm text-charcoal">
        <li className="flex gap-2">
          <span className="font-bold text-tan-dark">1.</span>
          <span>Download the <code className="rounded bg-surface px-1 py-0.5 text-xs">.exe</code> installer above and run it.</span>
        </li>
        <li className="flex gap-2">
          <span className="font-bold text-tan-dark">2.</span>
          <span>
            If Windows shows “Windows protected your PC”, click <strong>More info</strong> →{' '}
            <strong>Run anyway</strong>. This is expected — the installer isn’t code-signed yet.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-bold text-tan-dark">3.</span>
          <span>Open HIOC POS and sign in with your staff account.</span>
        </li>
        <li className="flex gap-2">
          <span className="font-bold text-tan-dark">4.</span>
          <span>
            Go to <strong>Printers</strong> → add your printer → tick <strong>Cash drawer</strong> if it’s
            plugged into that printer.
          </span>
        </li>
      </ol>

      <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
        Only one printer with no cash drawer? The browser-only fallback (a kiosk-printing Chrome shortcut,
        no drawer) is still documented in <code className="rounded bg-surface px-1 py-0.5">docs/POS-DEVICE-SETUP.md</code>.
      </p>
    </section>
  );
}

function PrinterSettingsInner({ bridge }: { bridge: HiocDesktopBridge }) {
  const [printers, setPrinters] = useState<PrinterConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [statuses, setStatuses] = useState<Record<string, PrinterStatus>>({});
  const [detected, setDetected] = useState<DetectedPrinter[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const printersRef = useRef(printers);
  printersRef.current = printers;

  const loadPrinters = useCallback(async () => {
    setLoading(true);
    try {
      const list = await bridge.printers.list();
      setPrinters(list);
    } catch {
      setSaveError('Could not load the printer list.');
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void loadPrinters();
  }, [loadPrinters]);

  // Live status dot — polled while this page is open (PRN-1). A status query
  // that throws just leaves that printer's dot at its last-known state.
  useEffect(() => {
    if (printers.length === 0) {
      setStatuses({});
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        printersRef.current.map(async (p) => {
          try {
            return [p.id, await bridge.printers.status(p.id)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setStatuses((prev) => {
        const next = { ...prev };
        for (const entry of entries) {
          if (entry) next[entry[0]] = entry[1];
        }
        return next;
      });
    };
    void poll();
    const timer = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- polls the ids in printersRef, not `printers` itself
  }, [bridge, printers.length]);

  const runDetect = useCallback(async () => {
    setDetecting(true);
    try {
      setDetected(await bridge.printers.detect());
    } catch {
      setDetected([]);
    } finally {
      setDetecting(false);
    }
  }, [bridge]);

  function startAdd() {
    setSaveError(null);
    setDraft(blankDraft());
    void runDetect();
  }

  function startEdit(p: PrinterConfig) {
    setSaveError(null);
    setDraft(draftFromPrinter(p));
    void runDetect();
  }

  function toggleRole(role: PrinterRole) {
    setDraft((d) => {
      if (!d) return d;
      const has = d.roles.includes(role);
      const roles = has ? d.roles.filter((r) => r !== role) : [...d.roles, role];
      const copies = { ...d.copies };
      if (has) delete copies[role];
      else if (copies[role] === undefined) copies[role] = 1;
      return { ...d, roles, copies };
    });
  }

  function setRoleCopies(role: PrinterRole, value: number) {
    const clamped = Math.min(5, Math.max(1, Math.trunc(value) || 1));
    setDraft((d) => (d ? { ...d, copies: { ...d.copies, [role]: clamped } } : d));
  }

  /**
   * Only one printer may drive the drawer (PRN-1). Turning this one on
   * silently turns it off everywhere else, both in the saved list and in the
   * draft being edited — enforced here rather than left as a rule the owner
   * has to remember.
   */
  function setDrawer(on: boolean) {
    setDraft((d) => (d ? { ...d, drawer: on } : d));
    if (on) setPrinters((prev) => prev.map((p) => (p.drawer ? { ...p, drawer: false } : p)));
  }

  async function saveDraft() {
    if (!draft) return;
    const err = draftError(draft);
    if (err) {
      setSaveError(err);
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const config = draftToConfig(draft);
      const withoutThis = printers.filter((p) => p.id !== config.id);
      const deduped = config.drawer ? withoutThis.map((p) => ({ ...p, drawer: false })) : withoutThis;
      const next = [...deduped, config];
      await bridge.printers.save(next);
      setPrinters(next);
      setDraft(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the printer.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(id: string) {
    setSaving(true);
    try {
      const next = printers.filter((p) => p.id !== id);
      await bridge.printers.save(next);
      setPrinters(next);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not delete the printer.');
    } finally {
      setSaving(false);
      setDeletingId(null);
    }
  }

  async function testPrint(p: PrinterConfig) {
    if (p.connection.kind === 'system' && p.connection.mode === 'driver') {
      setNotice((n) => ({ ...n, [p.id]: 'Driver printers are tested by printing a real order.' }));
      return;
    }
    setNotice((n) => ({ ...n, [p.id]: 'Sending…' }));
    try {
      const bytes = renderEscPos(testTicketDoc(p.name, p.paperWidthMm), {
        paperWidthMm: p.paperWidthMm,
        cut: p.cut,
        cutMode: p.cutMode,
      });
      const result = await bridge.printRaw(p.id, bytes);
      setNotice((n) => ({
        ...n,
        [p.id]: result.confirmed ? 'Test print confirmed by the printer.' : 'Sent — check the printer.',
      }));
    } catch (err) {
      setNotice((n) => ({ ...n, [p.id]: err instanceof Error ? err.message : 'Test print failed.' }));
    }
  }

  async function testCut(p: PrinterConfig) {
    if (!printerIsRawCapable(p)) {
      setNotice((n) => ({ ...n, [p.id]: 'Driver printers can’t send a cut command — set this printer to Raw.' }));
      return;
    }
    const cutMode = p.cutMode ?? 'standard';
    setNotice((n) => ({ ...n, [p.id]: 'Cutting…' }));
    try {
      const bytes = renderEscPos(cutTestTicketDoc(cutMode), {
        paperWidthMm: p.paperWidthMm,
        cut: true,
        cutMode,
      });
      const result = await bridge.printRaw(p.id, bytes);
      setNotice((n) => ({
        ...n,
        [p.id]: result.confirmed
          ? `Test cut (${CUT_MODE_LABELS[cutMode]}) confirmed by the printer.`
          : 'Sent — check the printer.',
      }));
    } catch (err) {
      setNotice((n) => ({ ...n, [p.id]: err instanceof Error ? err.message : 'Test cut failed.' }));
    }
  }

  async function testDrawer(p: PrinterConfig) {
    setNotice((n) => ({ ...n, [p.id]: 'Opening…' }));
    try {
      await bridge.openDrawer(p.id);
      setNotice((n) => ({ ...n, [p.id]: 'Drawer opened.' }));
    } catch (err) {
      setNotice((n) => ({ ...n, [p.id]: err instanceof Error ? err.message : 'Drawer did not open.' }));
    }
  }

  const detectedUsb = detected.filter(
    (d): d is DetectedPrinter & { connection: Extract<PrinterConnection, { kind: 'usb' }> } =>
      d.connection.kind === 'usb',
  );
  const detectedSystem = detected.filter(
    (d): d is DetectedPrinter & { connection: Extract<PrinterConnection, { kind: 'system' }> } =>
      d.connection.kind === 'system',
  );

  return (
    <section className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Printers</h1>
          <p className="mt-1 text-sm text-muted">
            Add the printers on this machine and assign KOT, Receipt and Token to them.
          </p>
          <SurfaceLink
            href="/staff/device"
            className="mt-2 inline-block text-sm font-bold text-tan underline decoration-tan/50 underline-offset-2 hover:text-tan-dark"
          >
            This counter — trusted-device setup
          </SurfaceLink>
        </div>
        {!draft ? (
          <button
            type="button"
            onClick={startAdd}
            className="min-h-[44px] shrink-0 rounded-md bg-tan px-4 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
          >
            Add printer
          </button>
        ) : null}
      </div>

      {saveError ? <p className="mt-4 text-sm text-red-700">{saveError}</p> : null}

      {loading ? (
        <p className="mt-6 text-sm text-muted">Loading printers…</p>
      ) : printers.length === 0 && !draft ? (
        <p className="mt-6 text-sm text-muted">No printers configured yet.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {printers.map((p) => {
            const status = statuses[p.id];
            const health = status?.health ?? 'unknown';
            return (
              <li key={p.id} className="rounded-md border border-[#e5e5e5] bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${HEALTH_DOT[health]}`}
                      />
                      <span className="text-sm font-bold text-charcoal">{p.name}</span>
                      {p.drawer ? (
                        <span className="rounded-md bg-[#f6efe9] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-tan-dark">
                          Drawer
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted">{connectionSummary(p.connection)}</p>
                    <p className="text-xs text-muted">
                      {p.paperWidthMm}mm · {p.roles.map((r) => ROLE_LABELS[r]).join(', ') || 'No roles assigned'}
                      {status?.detail ? ` · ${status.detail}` : ` · ${HEALTH_LABELS[health]}`}
                    </p>
                  </div>
                  {deletingId !== p.id ? (
                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingId(p.id)}
                        className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-red-700 hover:border-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-charcoal">Delete {p.name}?</span>
                      <button
                        type="button"
                        onClick={() => void confirmDelete(p.id)}
                        disabled={saving}
                        className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-bold text-cream hover:bg-red-800 disabled:opacity-50"
                      >
                        Yes, delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingId(null)}
                        className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void testPrint(p)}
                    className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                  >
                    Test print
                  </button>
                  {printerIsRawCapable(p) ? (
                    <button
                      type="button"
                      onClick={() => void testCut(p)}
                      className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                    >
                      Test cut
                    </button>
                  ) : null}
                  {p.drawer ? (
                    <button
                      type="button"
                      onClick={() => void testDrawer(p)}
                      className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                    >
                      Test drawer
                    </button>
                  ) : null}
                  {notice[p.id] ? <span className="text-xs text-muted">{notice[p.id]}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {draft ? (
        <div className="mt-6 rounded-md border border-tan bg-white p-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted">
            {printers.some((p) => p.id === draft.id) ? 'Edit printer' : 'Add printer'}
          </h2>

          <label className="mt-3 block text-sm">
            <span className="text-charcoal">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
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
                  onClick={() => setDraft((d) => (d ? { ...d, connKind: kind } : d))}
                  className={`min-h-[40px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                    draft.connKind === kind
                      ? 'border-charcoal bg-charcoal text-cream'
                      : 'border-[#e5e5e5] text-charcoal'
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
                  onChange={(e) => setDraft((d) => (d ? { ...d, networkHost: e.target.value } : d))}
                  placeholder="192.168.1.50"
                  className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
                />
              </label>
              <label className="text-sm">
                <span className="text-charcoal">Port</span>
                <input
                  value={draft.networkPort}
                  onChange={(e) => setDraft((d) => (d ? { ...d, networkPort: e.target.value } : d))}
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
                  onClick={() => void runDetect()}
                  disabled={detecting}
                  className="rounded-md border border-[#e5e5e5] px-3 py-1 text-xs font-bold text-charcoal hover:border-tan disabled:opacity-50"
                >
                  {detecting ? 'Scanning…' : 'Scan for printers'}
                </button>
              </div>
              {detectedUsb.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No USB printers detected. Plug one in and scan again.</p>
              ) : (
                <select
                  value={
                    draft.usb
                      ? `${draft.usb.vendorId}:${draft.usb.productId}:${draft.usb.serialNumber ?? ''}`
                      : ''
                  }
                  onChange={(e) => {
                    const match = detectedUsb.find(
                      (d) =>
                        `${d.connection.vendorId}:${d.connection.productId}:${d.connection.serialNumber ?? ''}` ===
                        e.target.value,
                    );
                    setDraft((d) => (d ? { ...d, usb: match ? match.connection : null } : d));
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
                  onClick={() => void runDetect()}
                  disabled={detecting}
                  className="rounded-md border border-[#e5e5e5] px-3 py-1 text-xs font-bold text-charcoal hover:border-tan disabled:opacity-50"
                >
                  {detecting ? 'Scanning…' : 'Scan for printers'}
                </button>
              </div>
              {detectedSystem.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No installed printers detected. Scan again.</p>
              ) : (
                <select
                  value={draft.systemDeviceName}
                  onChange={(e) => setDraft((d) => (d ? { ...d, systemDeviceName: e.target.value } : d))}
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
                    onClick={() => setDraft((d) => (d ? { ...d, systemMode: mode } : d))}
                    className={`min-h-[40px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                      draft.systemMode === mode
                        ? 'border-charcoal bg-charcoal text-cream'
                        : 'border-[#e5e5e5] text-charcoal'
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
                  onClick={() => setDraft((d) => (d ? { ...d, paperWidthMm: w } : d))}
                  className={`min-h-[40px] rounded-md border px-3 py-2 text-xs font-bold transition-colors ${
                    draft.paperWidthMm === w
                      ? 'border-charcoal bg-charcoal text-cream'
                      : 'border-[#e5e5e5] text-charcoal'
                  }`}
                >
                  {w}mm
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <span className="mb-1 block text-sm text-charcoal">Roles &amp; copies</span>
            <div className="flex flex-col gap-2 rounded-md border border-[#e5e5e5] p-2">
              {ROLES.map((role) => {
                const on = draft.roles.includes(role);
                return (
                  <div key={role} className="flex items-center justify-between gap-2 px-1 py-1">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-charcoal">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleRole(role)}
                        className="h-4 w-4 accent-tan"
                      />
                      {ROLE_LABELS[role]}
                    </label>
                    {on ? (
                      <label className="flex items-center gap-2 text-xs text-muted">
                        Copies
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={draft.copies[role] ?? 1}
                          onChange={(e) => setRoleCopies(role, Number(e.target.value))}
                          className="w-14 rounded-md border border-[#e5e5e5] px-2 py-1 text-right text-xs tabular-nums focus:border-tan focus:outline-none"
                        />
                      </label>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {isRawCapable(draft) ? (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-sm text-charcoal">Cut after print</span>
              <ToggleSwitch
                checked={draft.cut}
                onChange={(v) => setDraft((d) => (d ? { ...d, cut: v } : d))}
                label="Cut after print"
              />
            </div>
          ) : null}

          {isRawCapable(draft) && draft.cut ? (
            <div className="mt-3">
              <span className="mb-1 block text-sm text-charcoal">Cut style</span>
              <select
                value={draft.cutMode}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, cutMode: e.target.value as CutMode } : d))
                }
                className="mt-1 min-h-[44px] w-full rounded-md border border-[#e5e5e5] px-3 py-2.5 text-sm focus:border-tan focus:outline-none"
              >
                {CUT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {CUT_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted">{CUT_MODE_HINTS[draft.cutMode]}</p>
              <p className="mt-1 text-xs text-muted">
                If the paper doesn’t cut, try the next style and press Test cut again.
              </p>
            </div>
          ) : null}

          <div className="mt-4 flex items-center justify-between">
            <div>
              <span className="block text-sm text-charcoal">Drives the cash drawer</span>
              <span className="block text-xs text-muted">Only one printer can — turning this on turns it off elsewhere.</span>
            </div>
            <ToggleSwitch checked={draft.drawer} onChange={setDrawer} label="Drives the cash drawer" />
          </div>

          {saveError ? <p className="mt-3 text-sm text-red-700">{saveError}</p> : null}

          <div className="mt-5 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal hover:border-tan"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={saving}
              className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save printer'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
