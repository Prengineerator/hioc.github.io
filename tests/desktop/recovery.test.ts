// The desktop shell's recovery rules: which keys it keeps for itself, and how
// it retries a page that failed to load.
import { describe, expect, it } from 'vitest';
import { loadRetryDelayMs, shellKeyAction, shouldRetryLoad, type ShellKeyInput } from '../../desktop/src/recovery';

function input(over: Partial<ShellKeyInput>): ShellKeyInput {
  return { type: 'keyDown', key: '', control: false, meta: false, shift: false, alt: false, ...over };
}
const healthy = { packaged: true, pageHealthy: true };
const broken = { packaged: true, pageHealthy: false };

describe('shellKeyAction', () => {
  it('Ctrl+R always reloads the whole app — even a frozen page can be recovered', () => {
    expect(shellKeyAction(input({ key: 'r', control: true }), healthy)).toEqual({ type: 'reload', ignoreCache: false });
    expect(shellKeyAction(input({ key: 'R', control: true, shift: true }), healthy)).toEqual({
      type: 'reload',
      ignoreCache: true,
    });
  });

  it('F5 goes to the page (a data refresh) while the POS is up, a real reload when it is not', () => {
    expect(shellKeyAction(input({ key: 'F5' }), healthy)).toEqual({ type: 'page' });
    expect(shellKeyAction(input({ key: 'F5' }), broken)).toEqual({ type: 'reload', ignoreCache: false });
    expect(shellKeyAction(input({ key: 'F5', shift: true }), healthy)).toEqual({ type: 'reload', ignoreCache: true });
  });

  it('leaves the POS shortcuts to the page', () => {
    for (const key of ['n', 't', 'l', 'o', 's', 'f', 'Enter']) {
      expect(shellKeyAction(input({ key, control: true }), healthy)).toBeNull();
    }
  });

  it('Ctrl+Q quits; devtools stay shut only in a packaged build', () => {
    expect(shellKeyAction(input({ key: 'q', control: true }), healthy)).toEqual({ type: 'quit' });
    expect(shellKeyAction(input({ key: 'F12' }), healthy)).toEqual({ type: 'block' });
    expect(shellKeyAction(input({ key: 'F12' }), { packaged: false, pageHealthy: true })).toBeNull();
  });

  it('ignores key-up', () => {
    expect(shellKeyAction(input({ type: 'keyUp', key: 'r', control: true }), healthy)).toBeNull();
  });
});

describe('load retry', () => {
  it('backs off 2 s, 4 s, 8 s … and never waits more than 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(loadRetryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('retries main-frame failures, not an aborted navigation or a failed iframe', () => {
    expect(shouldRetryLoad(-106, true)).toBe(true); // ERR_INTERNET_DISCONNECTED
    expect(shouldRetryLoad(-3, true)).toBe(false); // ERR_ABORTED
    expect(shouldRetryLoad(-106, false)).toBe(false);
  });
});
