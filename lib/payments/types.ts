// Shared payment types safe to import from BOTH server code
// (lib/payments/gateway.ts, Route Handlers) and client code
// (lib/payments/razorpayCheckout.ts, components/checkout/CheckoutForm.tsx).
// Deliberately free of the 'server-only' guard and of any server-only
// imports — gateway.ts re-exports this for callers that only need the type.

export interface CreatedPaymentIntent {
  gateway: string; // e.g. 'razorpay'
  gatewayOrderId: string; // provider order id to hand to the client SDK
  amountInr: number;
  keyId?: string; // public key id for the client SDK (never the secret)
}
