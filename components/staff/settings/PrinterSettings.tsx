'use client';

// PRN-1/SET-1 — the printer settings screen, at /staff/settings/printers.
// Desktop-only: printer config is a physical fact of this counter machine
// (which USB port, which IP), so it's read and written entirely through
// `window.hiocDesktop` (lib/desktop/bridge) and never touches the server
// (D7-6, PRN-1 "Stored locally"). In a plain browser tab there is nothing to
// configure, so NoBridgePanel below explains why and points at the HIOC POS
// desktop app instead.
//
// The bridge check is done after mount (not during the first render) so the
// server-rendered HTML and the browser's first paint agree before hydration:
// SSR has no `window` at all, and even in the desktop app the preload's
// `window.hiocDesktop` may not be the very first thing React sees. Same
// pattern as the store-open badge in StaffHeader.
//
// SET-1 reorganised this from one long form into four clearly labelled,
// collapsible sub-sections — Printers, Ticket routing, Paper & cutting, Cash
// drawer — without changing any IPC call or the stored PrinterConfig shape:
// every write here still goes through the same bridge.printers.save(). The
// Add/Edit printer form (section a) keeps its explicit "Save printer" button
// (unchanged from before); the three page-wide sections below it — which
// edit an already-saved printer's routing/cut style/drawer directly rather
// than through that per-printer draft — auto-save on every change instead,
// the same pattern StoreControls uses, with a small inline "Saving…"/error
// note so the save state is never ambiguous.

import { useCallback, useEffect, useRef, useState } from 'react';
import { buttonVariants } from '@/components/ui/Button';
import { SurfaceLink } from '@/components/SurfaceLink';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type {
  DetectedPrinter,
  HiocDesktopBridge,
  PrinterConfig,
  PrinterConnection,
  PrinterStatus,
} from '@/lib/desktop/bridge';
import { renderEscPos } from '@/lib/print/escpos';
import { resolveBrandHeader } from '@/lib/desktop/printExecutor';
import { CUT_MODE_LABELS, cutTestTicketDoc, testTicketDoc } from '@/lib/print/testTicket';
import { SaveQueue } from '@/lib/staff/saveQueue';
import { PrinterCard } from './printers/PrinterCard';
import { PrinterForm } from './printers/PrinterForm';
import { TicketRoutingTable } from './printers/TicketRoutingTable';
import { PaperCuttingSection } from './printers/PaperCuttingSection';
import { CashDrawerSection } from './printers/CashDrawerSection';
import { STATUS_POLL_MS, blankDraft, draftError, draftFromPrinter, draftToConfig, printerIsRawCapable, type Draft } from './printers/shared';

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
    <section>
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
            Go to <strong>Settings → Printers &amp; cash drawer</strong> → add your printer → assign it a
            role and, if it&apos;s wired to the drawer, set it there too.
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

/** A page-level sub-section: a heading, short copy, and collapsible body —
 * used for the three sections below the printer list (native <details> so it
 * needs no JS and stays keyboard/screen-reader operable for free). */
function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <details open className="mt-6 rounded-md border border-[#e5e5e5] bg-white p-4">
      <summary className="cursor-pointer list-none">
        <h2 id={id} className="inline text-lg font-bold text-charcoal">
          {title}
        </h2>
        {description ? <p className="mt-1 text-xs text-muted">{description}</p> : null}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
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
  // Auto-save state for the Ticket routing / Paper & cutting / Cash drawer
  // sections — `savingId` names the printer currently mid-save so its row
  // can disable itself, `error` surfaces a failed autosave inline.
  const [autosave, setAutosave] = useState<{ savingId: string | null; error: string | null; section: string | null }>({
    savingId: null,
    error: null,
    section: null,
  });
  const [drawerTesting, setDrawerTesting] = useState(false);
  const printersRef = useRef(printers);
  printersRef.current = printers;

  // Backs the Ticket routing / Paper & cutting / Cash drawer sections' auto-
  // save (see lib/staff/saveQueue.ts for why: it fixes two toggled changes
  // in a row deriving from the same stale `printers` snapshot and one
  // silently clobbering the other). Built once per mount via the
  // lazy-ref-init pattern — `bridge` is stable for the component's lifetime,
  // so the queue's own `save` closure never needs to change.
  const saveQueueRef = useRef<SaveQueue<PrinterConfig[]>>();
  if (!saveQueueRef.current) {
    saveQueueRef.current = new SaveQueue<PrinterConfig[]>([], (list) => bridge.printers.save(list));
  }
  // Identifies the MOST RECENT autosave request, so that if a change is
  // superseded by a newer one before its own save settles, its (now
  // irrelevant) result doesn't clear the busy indicator or show an error out
  // from under the newer, still-in-flight one.
  const autosaveSeqRef = useRef(0);

  const loadPrinters = useCallback(async () => {
    setLoading(true);
    try {
      const list = await bridge.printers.list();
      saveQueueRef.current?.reset(list);
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
      // Keep the autosave queue's own notion of "latest" in sync — it isn't
      // used for THIS save (the form keeps its own explicit save button,
      // unchanged), but the next toggle in Ticket routing/Paper & cutting/
      // Cash drawer must build on this printer's addition/edit, not on
      // whatever the queue last saw.
      saveQueueRef.current?.reset(next);
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
      // Same as saveDraft() above — keep the autosave queue's "latest" in
      // sync so a subsequent routing/cutting/drawer toggle doesn't build on
      // a list that still contains the printer just deleted.
      saveQueueRef.current?.reset(next);
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
      const doc = await resolveBrandHeader(testTicketDoc(p.name, p.paperWidthMm), p.paperWidthMm);
      const bytes = renderEscPos(doc, {
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

  const [drawerNotice, setDrawerNotice] = useState<string | null>(null);

  async function testDrawer(p: PrinterConfig) {
    setDrawerTesting(true);
    setDrawerNotice('Opening…');
    try {
      await bridge.openDrawer(p.id);
      setDrawerNotice('Drawer opened.');
    } catch (err) {
      setDrawerNotice(err instanceof Error ? err.message : 'Drawer did not open.');
    } finally {
      setDrawerTesting(false);
    }
  }

  // On a failed autosave, the save that failed may be the only optimistic
  // update in flight (no later enqueue is going to re-attempt it — see
  // saveQueue.ts's "self-healing" note for when one IS), so the UI can be
  // showing a change that was never actually persisted. Reloading from the
  // bridge is the one way to know what's really saved; best-effort, since a
  // second failure here isn't worth stacking a second error message.
  const resyncAfterFailedAutosave = useCallback(async () => {
    try {
      const list = await bridge.printers.list();
      saveQueueRef.current?.reset(list);
      setPrinters(list);
    } catch {
      // Leave whatever's on screen — the autosave error already shown covers it.
    }
  }, [bridge]);

  /**
   * Ticket routing / Paper & cutting / Cash drawer all mutate the saved
   * printer list and save immediately — same bridge.printers.save() IPC call
   * the Add/Edit form uses, just triggered without an intermediate draft.
   * Routed through `saveQueueRef` (lib/staff/saveQueue.ts) rather than
   * building `next` from the `printers` prop/state directly: two quick
   * changes before the first save resolves must both land, in order, not
   * have the second silently overwrite the first with a stale snapshot.
   * `updater` therefore takes the LATEST enqueued list as `prev`, not
   * whatever `printers` happened to hold when the section component was
   * last rendered. `focusId` is only for the inline "Saving…" state on that
   * row; the cash-drawer "None" case touches every printer at once, so it's
   * omitted there.
   */
  function applyChange(updater: (prev: PrinterConfig[]) => PrinterConfig[], section: string, focusId?: string) {
    const queue = saveQueueRef.current;
    if (!queue) return;
    const seq = ++autosaveSeqRef.current;
    const next = queue.enqueue(updater, (result) => {
      // A newer change already took over the busy/error UI for this
      // section by the time this one's save settled — its own callback (or
      // a later one still) is the one that gets the final say.
      if (autosaveSeqRef.current !== seq) return;
      if (result.status === 'saved') {
        setAutosave({ savingId: null, error: null, section: null });
        return;
      }
      setAutosave({
        savingId: null,
        error: result.error instanceof Error ? result.error.message : 'Could not save that change.',
        section,
      });
      void resyncAfterFailedAutosave();
    });
    // Optimistic: render the change immediately rather than waiting on the
    // IPC round-trip — `next` is already the queue's up-to-date value, so
    // this is always the freshest state, even mid a run of quick toggles.
    setPrinters(next);
    setAutosave({ savingId: focusId ?? null, error: null, section });
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
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Printers &amp; cash drawer</h1>
          <p className="mt-1 text-sm text-muted">
            Add the printers on this machine, then route Receipt/KOT/Token, set cut style and the drawer below.
          </p>
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

      <section aria-labelledby="printers-heading" className="mt-6">
        <h2 id="printers-heading" className="text-lg font-bold text-charcoal">
          Printers
        </h2>

        {saveError ? <p className="mt-2 text-sm text-red-700">{saveError}</p> : null}

        {loading ? (
          <p className="mt-4 text-sm text-muted">Loading printers…</p>
        ) : printers.length === 0 && !draft ? (
          <p className="mt-4 text-sm text-muted">No printers configured yet.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {printers.map((p) => (
              <PrinterCard
                key={p.id}
                printer={p}
                status={statuses[p.id]}
                notice={notice[p.id]}
                deleting={deletingId === p.id}
                saving={saving}
                onEdit={() => startEdit(p)}
                onStartDelete={() => setDeletingId(p.id)}
                onConfirmDelete={() => void confirmDelete(p.id)}
                onCancelDelete={() => setDeletingId(null)}
                onTestPrint={() => void testPrint(p)}
                onTestCut={() => void testCut(p)}
              />
            ))}
          </ul>
        )}

        {draft ? (
          <PrinterForm
            draft={draft}
            isEdit={printers.some((p) => p.id === draft.id)}
            detecting={detecting}
            detectedUsb={detectedUsb}
            detectedSystem={detectedSystem}
            saveError={saveError}
            saving={saving}
            onChange={(updater) => setDraft((d) => (d ? updater(d) : d))}
            onRunDetect={() => void runDetect()}
            onCancel={() => setDraft(null)}
            onSave={() => void saveDraft()}
          />
        ) : null}
      </section>

      <Section id="routing-heading" title="Ticket routing" description="Which printer prints Receipt, KOT and Token, and how many copies.">
        <TicketRoutingTable
          printers={printers}
          savingId={autosave.savingId}
          onChange={(updater) => applyChange(updater, 'routing')}
        />
        {autosave.section === 'routing' && autosave.error ? (
          <p className="mt-2 text-sm text-red-700">{autosave.error}</p>
        ) : null}
      </Section>

      <Section id="cutting-heading" title="Paper & cutting" description="Cut after print, and which cut command to send.">
        <PaperCuttingSection
          printers={printers}
          savingId={autosave.savingId}
          onChange={(updater) => applyChange(updater, 'cutting')}
        />
        {autosave.section === 'cutting' && autosave.error ? (
          <p className="mt-2 text-sm text-red-700">{autosave.error}</p>
        ) : null}
      </Section>

      <Section id="drawer-heading" title="Cash drawer" description="Only one printer can drive the drawer at a time.">
        <CashDrawerSection
          printers={printers}
          notice={drawerNotice}
          testing={drawerTesting}
          onChange={(updater) => applyChange(updater, 'drawer')}
          onTest={(p) => void testDrawer(p)}
        />
        {autosave.section === 'drawer' && autosave.error ? (
          <p className="mt-2 text-sm text-red-700">{autosave.error}</p>
        ) : null}
      </Section>

      <p className="mt-6 text-xs text-muted">
        Enrolling or renaming this machine itself lives under{' '}
        <SurfaceLink href="/staff/settings/counter" className="font-bold text-tan underline decoration-tan/50 underline-offset-2 hover:text-tan-dark">
          This counter
        </SurfaceLink>
        .
      </p>
    </div>
  );
}
