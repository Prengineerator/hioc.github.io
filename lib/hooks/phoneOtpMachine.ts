// The WhatsApp-OTP flow's state, as a pure reducer (driven by usePhoneOtp, which
// does the network calls). Pure, so it is unit-tested without a renderer.
//
//   idle ──send──▶ (sending) ──ok──▶ sent ──verify──▶ (verifying) ──ok──▶ verified
//                      └──error──▶ idle + error          └──error──▶ sent + error
//   any ──the number is edited──▶ idle, not verified (the re-lock)
//
// One request at a time, and every answer is for the NUMBER IT WAS ASKED FOR.
// Before, a verify still in flight when the customer edited the number came back
// and marked the NEW number verified — the order then went out against a number
// nobody confirmed, which is exactly what the re-lock exists to stop. A send
// answering late opened the code box for a number the code never went to. Now
// an answer only lands if the number on screen is still the one it was asked
// for (compared as a mobile number, so "98765 43210" and "9876543210" match).

import { normalizeIndianMobile } from '@/lib/phone';

export type PhoneOtpStep = 'idle' | 'sent';
export type PhoneOtpRequestKind = 'send' | 'verify';

export interface PhoneOtpState {
  phone: string;
  verified: boolean;
  step: PhoneOtpStep;
  code: string;
  error: string | null;
  /** The request in flight and the number it was asked for; null when none. */
  pending: { id: number; kind: PhoneOtpRequestKind; phone: string } | null;
}

export type PhoneOtpEvent =
  | { type: 'phone_changed'; value: string }
  | { type: 'prefill'; value: string }
  | { type: 'code_changed'; value: string }
  | { type: 'cancel' }
  | { type: 'invalid'; message: string }
  | { type: 'request_started'; id: number; kind: PhoneOtpRequestKind; phone: string }
  | { type: 'request_succeeded'; id: number }
  | { type: 'request_failed'; id: number; message: string };

export function initialPhoneOtpState(phone = ''): PhoneOtpState {
  return { phone, verified: false, step: 'idle', code: '', error: null, pending: null };
}

/** The same mobile number, however it was typed; raw text when either isn't one. */
export function samePhoneNumber(a: string, b: string): boolean {
  const na = normalizeIndianMobile(a);
  const nb = normalizeIndianMobile(b);
  if (na !== null && nb !== null) return na === nb;
  return a.trim() === b.trim();
}

/** Would the answer to request `id` still apply to what is on screen? */
export function otpReplyApplies(state: Pick<PhoneOtpState, 'pending' | 'phone'>, id: number): boolean {
  return state.pending !== null && state.pending.id === id && samePhoneNumber(state.pending.phone, state.phone);
}

export function phoneOtpReducer(state: PhoneOtpState, event: PhoneOtpEvent): PhoneOtpState {
  switch (event.type) {
    case 'phone_changed':
      // Editing the number resets the whole flow, unconditionally. A request in
      // flight stays pending (so the buttons stay off until it answers) but its
      // answer will no longer apply — see otpReplyApplies.
      return { ...state, phone: event.value, verified: false, step: 'idle', code: '', error: null };
    case 'prefill':
      // Fills ONLY an empty field: a number someone started typing is never overwritten.
      return state.phone ? state : { ...state, phone: event.value };
    case 'code_changed':
      return { ...state, code: event.value };
    case 'cancel':
      return { ...state, step: 'idle', code: '', error: null };
    case 'invalid':
      return { ...state, error: event.message };
    case 'request_started':
      if (state.pending) return state; // one at a time
      return { ...state, error: null, pending: { id: event.id, kind: event.kind, phone: event.phone } };
    case 'request_succeeded': {
      if (!state.pending || state.pending.id !== event.id) return state;
      const applies = otpReplyApplies(state, event.id);
      const kind = state.pending.kind;
      const settled: PhoneOtpState = { ...state, pending: null };
      if (!applies) return settled; // asked for a number that is no longer on screen
      return kind === 'send'
        ? { ...settled, step: 'sent' }
        : { ...settled, verified: true, step: 'idle', code: '' };
    }
    case 'request_failed': {
      if (!state.pending || state.pending.id !== event.id) return state;
      const applies = otpReplyApplies(state, event.id);
      const settled: PhoneOtpState = { ...state, pending: null };
      return applies ? { ...settled, error: event.message } : settled;
    }
  }
}

export function phoneOtpBusy(state: Pick<PhoneOtpState, 'pending'>): boolean {
  return state.pending !== null;
}
