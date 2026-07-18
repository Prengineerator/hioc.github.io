// Shared new-order chime (S2). A single module-level AudioContext is unlocked
// once by an explicit "Enable sound" tap (browsers block audio until a user
// gesture — this is why the chime was silent), then reused for every alert.
// Synth-only loud square-wave alarm; no audio asset.

let ctx: AudioContext | null = null;
let unlocked = false;

type AudioContextCtor = typeof AudioContext;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Call from a user gesture (button click) to unlock audio. Returns success. */
export async function unlockChime(): Promise<boolean> {
  const c = ensureCtx();
  if (!c) return false;
  try {
    if (c.state === 'suspended') await c.resume();
    unlocked = c.state === 'running';
  } catch {
    unlocked = false;
  }
  return unlocked;
}

export function isChimeUnlocked(): boolean {
  return unlocked;
}

// Loud, urgent four-pulse "nee-naw" alarm (square wave cuts through cafe noise).
function render(c: AudioContext): void {
  const now = c.currentTime;
  const pulses = [
    { freq: 988, start: 0.0, duration: 0.2 },
    { freq: 1319, start: 0.22, duration: 0.2 },
    { freq: 988, start: 0.44, duration: 0.2 },
    { freq: 1319, start: 0.66, duration: 0.26 },
  ];
  for (const { freq, start, duration } of pulses) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const t0 = now + start;
    const t1 = t0 + duration;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.55, t0 + 0.015);
    gain.gain.setValueAtTime(0.55, t1 - 0.03);
    gain.gain.linearRampToValueAtTime(0, t1);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }
}

/** Plays the alarm through the unlocked context. No-op if not unlocked yet. */
export function playChime(): void {
  const c = ctx;
  if (!c) return;
  try {
    if (c.state === 'suspended') {
      c.resume().then(() => render(c)).catch(() => {});
    } else {
      render(c);
    }
  } catch {
    // Audio blocked/unavailable — never break the board.
  }
}
