import { describe, expect, it } from 'vitest';
import {
  appendPinDigit,
  filterOperatorsByName,
  logoutButtonLabel,
  logoutDestination,
  nextTileIndexForArrow,
  nextTileIndexForLetter,
  pinKeyAction,
  shouldRedirectClassicLogin,
} from '@/lib/staff/pinUi';

// PIN-2 — the owner's report ("not taking keyboard input", "logout... taking
// to the login interface rather than PIN") traced to three bits of pure
// logic that had never been extracted or tested: the PIN pad's keydown
// mapping, where "Log out" sends the staffer, and whether /staff/login
// should hand a PIN-capable counter back to the lock screen. All three live
// in lib/staff/pinUi.ts now, covered here without any DOM harness.

describe('pinKeyAction', () => {
  it('maps top-row and numpad digits alike (event.key is the same character)', () => {
    for (const d of '0123456789') {
      expect(pinKeyAction(d)).toEqual({ type: 'digit', digit: d });
    }
  });

  it('maps Backspace to backspace', () => {
    expect(pinKeyAction('Backspace')).toEqual({ type: 'backspace' });
  });

  it('maps Escape to back (return to the tile screen)', () => {
    expect(pinKeyAction('Escape')).toEqual({ type: 'back' });
  });

  it('claims Enter but there is nothing for it to do (submit is automatic)', () => {
    expect(pinKeyAction('Enter')).toEqual({ type: 'ignore' });
  });

  it('ignores letters and other keys', () => {
    expect(pinKeyAction('a')).toEqual({ type: 'ignore' });
    expect(pinKeyAction('Tab')).toEqual({ type: 'ignore' });
    expect(pinKeyAction('F5')).toEqual({ type: 'ignore' });
  });

  it('ignores a digit typed with ctrl/meta/alt held', () => {
    expect(pinKeyAction('1', { ctrlKey: true })).toEqual({ type: 'ignore' });
    expect(pinKeyAction('1', { metaKey: true })).toEqual({ type: 'ignore' });
    expect(pinKeyAction('1', { altKey: true })).toEqual({ type: 'ignore' });
  });

  it('does not ignore a plain digit with every modifier explicitly false', () => {
    expect(pinKeyAction('7', { ctrlKey: false, metaKey: false, altKey: false })).toEqual({
      type: 'digit',
      digit: '7',
    });
  });
});

describe('appendPinDigit', () => {
  it('appends and clamps to maxLength', () => {
    expect(appendPinDigit('', '1', 4)).toBe('1');
    expect(appendPinDigit('123', '4', 4)).toBe('1234');
    expect(appendPinDigit('1234', '5', 4)).toBe('1234');
  });
});

describe('logoutDestination', () => {
  it('sends a PIN-capable counter to /staff with a hard reload', () => {
    expect(logoutDestination(true)).toEqual({ href: '/staff', hardReload: true });
  });

  it('sends everyone else to /staff/login with a soft navigation', () => {
    expect(logoutDestination(false)).toEqual({ href: '/staff/login', hardReload: false });
  });
});

describe('logoutButtonLabel', () => {
  it('is always "Log out" — distinct from the separate Switch/Lock control', () => {
    expect(logoutButtonLabel(true)).toBe('Log out');
    expect(logoutButtonLabel(false)).toBe('Log out');
  });
});

describe('shouldRedirectClassicLogin', () => {
  it('redirects a PIN-eligible, enrolled counter with no ?classic param', () => {
    expect(
      shouldRedirectClassicLogin({ pinEligible: true, deviceEnrolled: true, classicParam: undefined }),
    ).toBe(true);
  });

  it('does not redirect when the flag/secret gate is off', () => {
    expect(
      shouldRedirectClassicLogin({ pinEligible: false, deviceEnrolled: true, classicParam: undefined }),
    ).toBe(false);
  });

  it('does not redirect when this machine is not an enrolled device', () => {
    expect(
      shouldRedirectClassicLogin({ pinEligible: true, deviceEnrolled: false, classicParam: undefined }),
    ).toBe(false);
  });

  it('does not redirect when ?classic is present, at any truthy value', () => {
    expect(shouldRedirectClassicLogin({ pinEligible: true, deviceEnrolled: true, classicParam: '1' })).toBe(
      false,
    );
    expect(
      shouldRedirectClassicLogin({ pinEligible: true, deviceEnrolled: true, classicParam: ['1'] }),
    ).toBe(false);
  });

  it('treats an empty-string classic param as absent (still redirects)', () => {
    expect(shouldRedirectClassicLogin({ pinEligible: true, deviceEnrolled: true, classicParam: '' })).toBe(
      true,
    );
  });

  it('never disagrees with app/staff/layout.tsx\'s own pinEligible && device check', () => {
    // The layout only shows the lock screen (rather than redirecting to
    // /staff/login) when pinEligible && device — mirrored here so the two
    // routes can never bounce a request back and forth forever.
    const cases = [
      { pinEligible: true, deviceEnrolled: true },
      { pinEligible: true, deviceEnrolled: false },
      { pinEligible: false, deviceEnrolled: true },
      { pinEligible: false, deviceEnrolled: false },
    ];
    for (const c of cases) {
      const layoutShowsLockScreen = c.pinEligible && c.deviceEnrolled;
      const loginRedirectsToLockScreen = shouldRedirectClassicLogin({ ...c, classicParam: undefined });
      expect(loginRedirectsToLockScreen).toBe(layoutShowsLockScreen);
    }
  });
});

describe('nextTileIndexForLetter', () => {
  const names = ['Amit', 'Bina', 'Amrita', 'Ravi'];

  it('jumps to the next tile starting with the letter, wrapping around', () => {
    expect(nextTileIndexForLetter(names, 'a', 0)).toBe(2); // wraps past Amit itself to Amrita
    expect(nextTileIndexForLetter(names, 'a', 2)).toBe(0); // wraps all the way around
  });

  it('cycles through repeats on successive presses starting fresh', () => {
    expect(nextTileIndexForLetter(names, 'a', -1)).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(nextTileIndexForLetter(names, 'A', -1)).toBe(0);
  });

  it('returns null when nothing matches', () => {
    expect(nextTileIndexForLetter(names, 'z', 0)).toBeNull();
  });

  it('returns null for an empty list or a non-single-character input', () => {
    expect(nextTileIndexForLetter([], 'a', 0)).toBeNull();
    expect(nextTileIndexForLetter(names, 'ab', 0)).toBeNull();
  });
});

describe('nextTileIndexForArrow', () => {
  // 3-column grid, 7 tiles: rows of [0,1,2] [3,4,5] [6]
  const count = 7;
  const columns = 3;

  it('moves right and left within a row', () => {
    expect(nextTileIndexForArrow('ArrowRight', 0, count, columns)).toBe(1);
    expect(nextTileIndexForArrow('ArrowLeft', 1, count, columns)).toBe(0);
  });

  it('moves down and up a row', () => {
    expect(nextTileIndexForArrow('ArrowDown', 0, count, columns)).toBe(3);
    expect(nextTileIndexForArrow('ArrowUp', 3, count, columns)).toBe(0);
  });

  it('clamps at the edges instead of wrapping', () => {
    expect(nextTileIndexForArrow('ArrowLeft', 0, count, columns)).toBe(0);
    expect(nextTileIndexForArrow('ArrowRight', count - 1, count, columns)).toBe(count - 1);
    expect(nextTileIndexForArrow('ArrowDown', count - 1, count, columns)).toBe(count - 1);
    expect(nextTileIndexForArrow('ArrowUp', 0, count, columns)).toBe(0);
  });

  it('is a no-op on an empty grid', () => {
    expect(nextTileIndexForArrow('ArrowRight', 0, 0, columns)).toBe(0);
  });
});

describe('filterOperatorsByName', () => {
  const operators = [{ name: 'Amit' }, { name: 'Bina' }, { name: 'Amrita' }];

  it('matches a case-insensitive substring', () => {
    expect(filterOperatorsByName(operators, 'am')).toEqual([{ name: 'Amit' }, { name: 'Amrita' }]);
  });

  it('returns everyone for an empty/whitespace query', () => {
    expect(filterOperatorsByName(operators, '')).toEqual(operators);
    expect(filterOperatorsByName(operators, '   ')).toEqual(operators);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterOperatorsByName(operators, 'zzz')).toEqual([]);
  });
});
