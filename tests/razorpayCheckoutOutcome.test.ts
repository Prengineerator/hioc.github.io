import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRazorpayCheckout, outcomeMayHaveCharged, type RazorpayOutcome } from '@/lib/payments/razorpayCheckout';

// lib/payments/razorpayCheckout.ts: the promise settles on how the checkout
// ENDED, once — it used to resolve right after rzp.open(), so callers that
// awaited it cleared their "paying" flag while the window was still up.

type Options = {
  handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => Promise<void>;
  modal: { ondismiss: () => void };
};

class FakeRazorpay {
  static last: FakeRazorpay | null = null;
  static throwOnOpen = false;
  options: Options;
  failed: ((r: { error?: { description?: string } }) => void) | null = null;
  opened = false;
  constructor(options: Record<string, unknown>) {
    this.options = options as unknown as Options;
    FakeRazorpay.last = this;
  }
  on(_event: 'payment.failed', cb: (r: { error?: { description?: string } }) => void) {
    this.failed = cb;
  }
  open() {
    if (FakeRazorpay.throwOnOpen) throw new Error('blocked');
    this.opened = true;
  }
}

const intent = { gateway: 'razorpay', gatewayOrderId: 'order_1', amountInr: 250, keyId: 'rzp_test' };
const success = { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'sig' };
const flush = () => new Promise((r) => setTimeout(r, 0));

function callbacks() {
  return { onSuccess: vi.fn(), onDismiss: vi.fn(), onFailure: vi.fn(), onPaymentFailed: vi.fn() };
}

/** Starts a checkout and waits until the (fake) window is open. */
async function start(cb = callbacks()) {
  let settled: RazorpayOutcome | null = null;
  const promise = openRazorpayCheckout(intent, { name: 'A', phone: '9876543210', ...cb }).then((o) => {
    settled = o;
    return o;
  });
  await flush();
  return { promise, cb, settled: () => settled, rzp: FakeRazorpay.last! };
}

beforeEach(() => {
  FakeRazorpay.last = null;
  FakeRazorpay.throwOnOpen = false;
  vi.stubGlobal('window', { Razorpay: FakeRazorpay });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openRazorpayCheckout outcome', () => {
  it('does NOT settle when the window opens', async () => {
    const { settled, rzp } = await start();
    expect(rzp.opened).toBe(true);
    await flush();
    expect(settled()).toBeNull();
  });

  it('settles "dismissed" (with the last in-window failure) when the window is closed', async () => {
    const { promise, cb, rzp } = await start();
    rzp.failed!({ error: { description: 'Card declined' } });
    expect(cb.onPaymentFailed).toHaveBeenCalledWith('Card declined');
    rzp.options.modal.ondismiss();
    expect(await promise).toEqual({ kind: 'dismissed', lastFailure: 'Card declined' });
    expect(cb.onDismiss).toHaveBeenCalledWith('Card declined');
  });

  it('settles "paid" only after the signature verified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { promise, cb, rzp } = await start();
    await rzp.options.handler(success);
    expect(await promise).toEqual({ kind: 'paid' });
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('settles "unverified" when the gateway said success but verifying failed — money may have moved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Bad gateway' }), { status: 502 })));
    const { promise, cb, rzp } = await start();
    await rzp.options.handler(success);
    const outcome = await promise;
    expect(outcome).toEqual({ kind: 'unverified', message: 'Bad gateway' });
    expect(outcomeMayHaveCharged(outcome)).toBe(true);
    expect(cb.onFailure).toHaveBeenCalledWith('Bad gateway');
  });

  it('a network error while verifying is "unverified" too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const { promise, rzp } = await start();
    await rzp.options.handler(success);
    expect((await promise).kind).toBe('unverified');
  });

  it('hears only one ending: a dismiss after the success handler started is ignored', async () => {
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (release = () => r(new Response('{}', { status: 200 }))))));
    const { promise, cb, rzp } = await start();
    const handled = rzp.options.handler(success);
    rzp.options.modal.ondismiss(); // the window closing while we verify
    release();
    await handled;
    expect(await promise).toEqual({ kind: 'paid' });
    expect(cb.onDismiss).not.toHaveBeenCalled();
    expect(cb.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('"unavailable" when there is no key, or the window cannot open: nothing could be charged', async () => {
    const cb = callbacks();
    const noKey = await openRazorpayCheckout({ ...intent, keyId: undefined }, { name: '', phone: '', ...cb });
    expect(noKey.kind).toBe('unavailable');
    expect(outcomeMayHaveCharged(noKey)).toBe(false);
    expect(cb.onFailure).toHaveBeenCalledTimes(1);

    FakeRazorpay.throwOnOpen = true;
    const cb2 = callbacks();
    const refused = await openRazorpayCheckout(intent, { name: '', phone: '', ...cb2 });
    expect(refused.kind).toBe('unavailable');
    expect(cb2.onFailure).toHaveBeenCalledTimes(1);
  });

  it('outcomeMayHaveCharged: only a gateway success', () => {
    expect(outcomeMayHaveCharged({ kind: 'paid' })).toBe(true);
    expect(outcomeMayHaveCharged({ kind: 'dismissed' })).toBe(false);
    expect(outcomeMayHaveCharged({ kind: 'dismissed', lastFailure: 'x' })).toBe(false);
  });
});
