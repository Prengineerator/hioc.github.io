import { describe, expect, it } from 'vitest';

// POS-5 — the pure `.or()` filter string behind "every order that belongs to
// whoever this phone/account is" (GET /api/customers/lookup's order-history
// fallback + GET /api/customers/orders). No mocks: this is a function of its
// two arguments, same reasoning as tests/posLoyalty.test.ts.
//
// Two things this specifically guards:
//  1. Legacy rows — a few older orders still store the bare 10-digit phone
//     instead of the +91-prefixed form every order since has used. Both
//     forms must be matched, or those rows silently vanish from a returning
//     customer's count/list.
//  2. The `+` in "+91XXXXXXXXXX" must reach PostgREST as a literal `+`, not a
//     space — this is exactly why the values are double-quoted.

import { orderMatchFilter } from '@/lib/loyalty/customerLink';

describe('orderMatchFilter', () => {
  it('matches BOTH the +91-prefixed and bare-digit legacy phone formats', () => {
    expect(orderMatchFilter('+919876543210', null)).toBe(
      'customer_phone.in.("+919876543210","9876543210")',
    );
  });

  it('quotes each phone value — the "+" must reach PostgREST as a literal, never a decoded space', () => {
    const filter = orderMatchFilter('+919876543210', null);
    expect(filter).toContain('"+919876543210"');
    // An UNQUOTED "+" is exactly the bug this guards against.
    expect(filter).not.toContain('.in.(+9');
  });

  it('widens to the linked account\'s customer_user_id/user_id when one is given', () => {
    expect(orderMatchFilter('+919876543210', 'cust-1')).toBe(
      'customer_phone.in.("+919876543210","9876543210"),customer_user_id.eq.cust-1,user_id.eq.cust-1',
    );
  });

  it('never widens by account when none is linked — only the phone counts', () => {
    const filter = orderMatchFilter('+919876543210', null);
    expect(filter).not.toContain('customer_user_id');
    expect(filter).not.toContain('user_id');
  });

  it('does not duplicate the phone variant when the input is already bare (defensive; callers always pass +91 form)', () => {
    expect(orderMatchFilter('9876543210', null)).toBe('customer_phone.in.("9876543210")');
  });
});
