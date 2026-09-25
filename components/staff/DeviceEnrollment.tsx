'use client';

// DEV-2/SHL — "This counter". Shown at /staff/device, linked from the
// Printers page and the staff header.
//
// Desktop-only, like PrinterSettings: the whole point is a FACT ABOUT THE
// MACHINE the browser is running on, and a plain browser tab has no
// meaningful "this machine" to enrol — same bridge-check-after-mount pattern
// as PrinterSettings.tsx (SSR has no `window`, so the check runs after mount
// and renders nothing until it has).
//
// Why there's a "sign in as the owner" step here, and not just an isOwner
// check: /staff/login only ever establishes a 'staff'-audience session
// (lib/auth/audience.ts) — an owner account is refused there by design (that
// restriction is what stops a counter tablet's bookmark from opening
// payroll). So an owner session can never simply *already be* the one
// signed in on this screen. This form calls the exact same
// POST /api/auth/login the owner's own login page uses, with
// audience: 'owner' — same credential check, same door, just reachable from
// this screen instead of a page the app window can no longer navigate to.
// It replaces whatever session was active on this machine, which is the
// expected one-time-setup trade — the counter's usual staff account signs
// back in afterwards the same way it always has.
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

const MAX_NAME_LEN = 40;

interface DeviceInfo {
  name: string;
  enrolled_at: string;
}

export function DeviceEnrollment({
  isOwner,
  registryAvailable,
  device: initialDevice,
}: {
  isOwner: boolean;
  registryAvailable: boolean;
  device: DeviceInfo | null;
}) {
  const [checked, setChecked] = useState(false);
  const [inApp, setInApp] = useState(false);

  useEffect(() => {
    setInApp(getDesktopBridge() !== null);
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (!inApp) return <BrowserNote />;

  if (!registryAvailable) {
    return (
      <Panel>
        <p className="text-sm text-charcoal">
          Device setup isn&apos;t available yet (database update pending).
        </p>
      </Panel>
    );
  }

  if (initialDevice) return <EnrolledPanel device={initialDevice} />;

  return isOwner ? <EnrollForm /> : <AskOwnerPanel />;
}

function Panel({ children }: { children: React.ReactNode }) {
  return <section className="rounded-md border border-line bg-cream p-5">{children}</section>;
}

/** Shown in a plain browser tab — there's no bridge, so no "this machine" to
 * name. PrinterSettings' NoBridgePanel is the fuller version of this same
 * explanation; this stays short since the page's real job here is enrolment,
 * not re-explaining the app. */
function BrowserNote() {
  return (
    <Panel>
      <p className="text-sm text-charcoal">
        Trusted counters are set up in the HIOC POS app, not in a browser tab.
      </p>
      <p className="mt-2 text-sm text-muted">
        Open the HIOC POS app on this machine, sign in, and come back to Printers → This counter.
      </p>
    </Panel>
  );
}

function EnrolledPanel({ device }: { device: DeviceInfo }) {
  const enrolledDate = new Date(device.enrolled_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return (
    <Panel>
      <div className="flex items-center gap-2">
        <Badge variant="success">Trusted counter</Badge>
      </div>
      <p className="mt-3 text-lg font-bold text-charcoal">{device.name}</p>
      <p className="text-sm text-muted">Enrolled {enrolledDate}</p>
    </Panel>
  );
}

/** Not enrolled, not the owner — the common case. Every staffer sees this;
 * the owner sign-in below is a deliberately quiet, collapsed escape hatch
 * rather than a form sitting open on the counter's everyday screen. */
function AskOwnerPanel() {
  const [showOwnerSignIn, setShowOwnerSignIn] = useState(false);

  return (
    <Panel>
      <p className="text-sm text-charcoal">This counter isn&apos;t enrolled yet.</p>
      <p className="mt-2 text-sm text-muted">Ask the owner to enrol this counter from this app.</p>

      {showOwnerSignIn ? (
        <div className="mt-4 border-t border-line pt-4">
          <OwnerSignInForm onCancel={() => setShowOwnerSignIn(false)} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowOwnerSignIn(true)}
          className="mt-4 text-sm font-bold text-tan underline decoration-tan/50 underline-offset-2 hover:text-tan-dark"
        >
          Owner: sign in to enrol this counter
        </button>
      )}
    </Panel>
  );
}

/**
 * A dedicated owner-audience sign-in, local to this screen — see the file
 * comment for why /staff/login can't be reused for this. Reuses
 * POST /api/auth/login exactly as the owner's own login page calls it.
 */
function OwnerSignInForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, audience: 'owner' }),
      });
      if (res.ok) {
        // Re-runs the server check with the new session — this screen then
        // renders the Enrol form (or the "already enrolled" panel) instead
        // of this sign-in step.
        router.refresh();
        return;
      }
      if (res.status === 401) {
        setError('Invalid email or password.');
      } else {
        const data = await res.json().catch(() => ({ error: 'Sign-in failed' }));
        setError(data.error ?? 'Sign-in failed');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        This signs the owner in on this counter, replacing the session currently signed in here. Staff can
        sign back in afterwards as usual.
      </p>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
      <Input
        label="Owner email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" loading={submitting}>
          Sign in
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Owner, not yet enrolled: name it and enrol. Enrolling always enrols the
 * machine making the request (POST /api/owner/devices), exactly as
 * DeviceManager on /owner/devices does — reused verbatim, not duplicated. */
function EnrollForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enrolled, setEnrolled] = useState<DeviceInfo | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name this device so you can recognise it later.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Could not enrol this counter.');
        return;
      }
      setEnrolled({ name: data.device.name, enrolled_at: data.device.enrolled_at });
      // Picks up the enrolled-device cookie the response just set and
      // re-runs the server check, so a reload of this page (or Printers)
      // shows the enrolled state without a stale cache.
      router.refresh();
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (enrolled) return <EnrolledPanel device={enrolled} />;

  return (
    <Panel>
      <p className="text-sm text-charcoal">This counter isn&apos;t enrolled yet.</p>
      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
        {error ? (
          <p role="alert" className="text-sm font-semibold text-red-700">
            {error}
          </p>
        ) : null}
        <Input
          label="Name this counter"
          placeholder="Counter 1"
          maxLength={MAX_NAME_LEN}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" loading={submitting}>
          Enrol this counter
        </Button>
      </form>
    </Panel>
  );
}
