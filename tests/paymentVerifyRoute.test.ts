import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for POST /api/payments/verify. Uses the REAL signature
// check (lib/payments/gateway.ts) with the Razorpay REST call and the capture
// logic mocked, so the route's decisions — field validation, signature gate,
// capture-only-when-captured — are exercised without network or DB.

const state: {
  attempt: Record<string, unknown> | null;
  captureCalls: Record<string, unknown>[];
} = { attempt: null, captureCalls: [] };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));
vi.mock('@/lib/payments/reconcile', () => ({
  captureGatewayPayment: (params: Record<string, unknown>) => {
    state.captureCalls.push(params);
    return Promise.resolve({ ok: true, order: { payment_status: 'paid', status: 'received' } });
  },
}));

const SECRET = 'test_secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = SECRET;

// Imported after mocks are registered (vi.mock is hoisted).
const { POST } = await import('@/app/api/payments/verify/route');

const ORDER_ID = 'order_ABC123';
const PAYMENT_ID = 'pay_XYZ789';
const sign = (orderId: string, paymentId: string) =>
  createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

function req(body: unknown) {
  return new Request('http://localhost/api/payments/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.attempt = { id: PAYMENT_ID, order_id: ORDER_ID, status: 'captured', method: 'upi', amount: 25000 };
  state.captureCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(state.attempt), { status: 200 }))),
  );
});

describe('POST /api/payments/verify', () => {
  it('400s when any field is missing', async () => {
    const res = await POST(req({ razorpay_order_id: ORDER_ID, razorpay_payment_id: PAYMENT_ID }));
    expect(res.status).toBe(400);
    expect(state.captureCalls).toHaveLength(0);
  });

  it('400s on a signature mismatch and does not mark paid', async () => {
    const res = await POST(
      req({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: sign(ORDER_ID, 'pay_OTHER'),
      }),
    );
    expect(res.status).toBe(400);
    expect(state.captureCalls).toHaveLength(0);
  });

  it('captures a verified, captured payment', async () => {
    const res = await POST(
      req({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: sign(ORDER_ID, PAYMENT_ID),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true, payment_status: 'paid', order_status: 'received' });
    expect(state.captureCalls).toEqual([
      {
        gatewayOrderId: ORDER_ID,
        gatewayPaymentId: PAYMENT_ID,
        method: 'upi',
        signatureOk: true,
        capturedAmountPaise: 25000,
      },
    ]);
  });

  it('leaves a verified but not-yet-captured payment pending', async () => {
    state.attempt = { ...state.attempt, status: 'authorized' };
    const res = await POST(
      req({
        razorpay_order_id: ORDER_ID,
        razorpay_payment_id: PAYMENT_ID,
        razorpay_signature: sign(ORDER_ID, PAYMENT_ID),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true, payment_status: 'payment_pending' });
    expect(state.captureCalls).toHaveLength(0);
  });
});
