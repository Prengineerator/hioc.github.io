import { describe, expect, it } from 'vitest';

// POS-5 — the pure guard behind phone-first name autofill. No mocks: this is
// a function of its two arguments, same reasoning as tests/posLoyalty.test.ts.

import { shouldAutofillName } from '@/lib/pos/nameAutofill';

describe('shouldAutofillName', () => {
  it('fills an empty field regardless of the edited flag', () => {
    expect(shouldAutofillName('', false)).toBe(true);
    expect(shouldAutofillName('', true)).toBe(true);
    expect(shouldAutofillName('   ', true)).toBe(true); // whitespace-only counts as empty
  });

  it('fills a non-empty field that has NOT been hand-edited (still the last autofill)', () => {
    expect(shouldAutofillName('Priya', false)).toBe(true);
  });

  it('never overwrites a name the cashier typed by hand', () => {
    expect(shouldAutofillName('Someone Else', true)).toBe(false);
  });
});
