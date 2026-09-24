import { describe, expect, it } from 'vitest';
import { checkoutPrefill } from '@/lib/account/prefill';

// What checkout prefills for a signed-in customer (GET /api/account/me →
// `prefill`). WhatsApp-code logins have no profile name and no login email,
// so both fields must fall back to the customer's most recent order.

describe('checkoutPrefill', () => {
  const lastOrder = { customer_name: 'Asha', customer_email: 'asha@example.com' };

  it('prefers the profile name and the verified login email', () => {
    expect(checkoutPrefill('Asha K', 'asha.k@example.com', lastOrder)).toEqual({
      name: 'Asha K',
      email: 'asha.k@example.com',
    });
  });

  it('falls back to the last order when the profile has neither', () => {
    expect(checkoutPrefill('', null, lastOrder)).toEqual({ name: 'Asha', email: 'asha@example.com' });
    expect(checkoutPrefill('   ', undefined, lastOrder)).toEqual({ name: 'Asha', email: 'asha@example.com' });
  });

  it('fills each field independently', () => {
    expect(checkoutPrefill('Asha K', null, lastOrder)).toEqual({ name: 'Asha K', email: 'asha@example.com' });
    expect(checkoutPrefill('', 'asha.k@example.com', lastOrder)).toEqual({
      name: 'Asha',
      email: 'asha.k@example.com',
    });
  });

  it('returns empty strings when there is nothing to prefill', () => {
    expect(checkoutPrefill(null, null, null)).toEqual({ name: '', email: '' });
    expect(checkoutPrefill('', null, { customer_name: null, customer_email: null })).toEqual({ name: '', email: '' });
  });
});
