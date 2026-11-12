// PIN-2 — the lock overlay's two states, as one small pure machine so the
// Lock button and the idle timeout cannot drift apart again
// (StaffPinOverlay.tsx). Framework-free and unit-tested
// (tests/pinOverlayState.test.ts).
//
//   unlocked —lock (Lock/Switch button, or the idle timeout)→ locked
//   locked   —unlock (a PIN accepted on the lock screen)→      unlocked
//   locked   —lock→ locked (already locked: nothing changes)
//
// Every lock, whatever caused it, ENDS THE OPERATOR SESSION (clears the
// operator cookie via DELETE /api/device/operator), not just the screen. The
// idle timeout used to only raise the overlay: the cookie stayed valid, so a
// reload brought the previous operator straight back, unlocked, and whatever
// the next person did was attributed to them.

export const PIN_OVERLAY_STATES = ['unlocked', 'locked'] as const;
export type PinOverlayState = (typeof PIN_OVERLAY_STATES)[number];

export type PinLockCause = 'button' | 'idle';

export type PinOverlayEvent = { type: 'lock'; cause: PinLockCause } | { type: 'unlock'; operatorName: string };

export interface PinOverlayModel {
  state: PinOverlayState;
  /** Who the server says is operating; null for a classic session. */
  operatorName: string | null;
}

export interface PinOverlayStep {
  next: PinOverlayModel;
  /** True when this step must clear the operator cookie (every lock does). */
  endOperatorSession: boolean;
}

/**
 * Every lock clears the operator cookie — even when the screen is already
 * locked: a second clear is harmless, and "locked" must never be a state the
 * server disagrees with. Depends on the event alone, so the component can act
 * on it without reading state mid-update.
 */
export function endsOperatorSession(event: PinOverlayEvent): boolean {
  return event.type === 'lock';
}

export function pinOverlayStep(model: PinOverlayModel, event: PinOverlayEvent): PinOverlayStep {
  const next: PinOverlayModel =
    event.type === 'lock' ? { ...model, state: 'locked' } : { state: 'unlocked', operatorName: event.operatorName };
  return { next, endOperatorSession: endsOperatorSession(event) };
}
