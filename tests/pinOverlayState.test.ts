import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIN_OVERLAY_STATES,
  endsOperatorSession,
  pinOverlayStep,
  type PinOverlayModel,
} from '@/components/staff/pin/overlayState';

// The PIN overlay's two states (components/staff/pin/overlayState.ts). The
// idle timeout used to only raise the overlay while the operator cookie stayed
// valid, so a reload brought the previous operator back unlocked; now every
// lock — button or idle — ends the operator session the same way.

const unlocked: PinOverlayModel = { state: 'unlocked', operatorName: 'Priya' };

describe('pinOverlayStep', () => {
  it('has exactly two states', () => {
    expect([...PIN_OVERLAY_STATES]).toEqual(['unlocked', 'locked']);
  });

  it('the idle timeout locks exactly like the Lock button — screen AND operator session', () => {
    const byButton = pinOverlayStep(unlocked, { type: 'lock', cause: 'button' });
    const byIdle = pinOverlayStep(unlocked, { type: 'lock', cause: 'idle' });
    expect(byIdle).toEqual(byButton);
    expect(byIdle).toEqual({ next: { state: 'locked', operatorName: 'Priya' }, endOperatorSession: true });
  });

  it('locking again while locked still clears the session; unlocking names the new operator', () => {
    const locked = pinOverlayStep(unlocked, { type: 'lock', cause: 'idle' }).next;
    expect(pinOverlayStep(locked, { type: 'lock', cause: 'button' })).toMatchObject({
      next: { state: 'locked' },
      endOperatorSession: true,
    });
    expect(pinOverlayStep(locked, { type: 'unlock', operatorName: 'Ravi' })).toEqual({
      next: { state: 'unlocked', operatorName: 'Ravi' },
      endOperatorSession: false,
    });
    expect(endsOperatorSession({ type: 'unlock', operatorName: 'Ravi' })).toBe(false);
  });
});

describe('StaffPinOverlay uses the one lock path', () => {
  const source = readFileSync(path.resolve(__dirname, '../components/staff/pin/StaffPinOverlay.tsx'), 'utf8');

  it('the idle timer and the Lock button both call lock(), which clears the operator cookie', () => {
    expect(source).toMatch(/setTimeout\(\(\) => void lock\('idle'\), IDLE_MS\)/);
    expect(source).toMatch(/void lock\('button'\)/);
    expect(source).toMatch(/endsOperatorSession\(event\)/);
    expect(source).toMatch(/fetch\('\/api\/device\/operator', \{ method: 'DELETE' \}\)/);
    // No second, screen-only way to lock.
    expect(source).not.toMatch(/setLocked/);
  });
});
