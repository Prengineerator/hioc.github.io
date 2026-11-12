import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  initialPhoneOtpState,
  otpReplyApplies,
  phoneOtpBusy,
  phoneOtpReducer,
  samePhoneNumber,
  type PhoneOtpEvent,
  type PhoneOtpState,
} from '@/lib/hooks/phoneOtpMachine';

// The WhatsApp-OTP flow (lib/hooks/phoneOtpMachine.ts, driven by usePhoneOtp):
// one request at a time, and an answer only lands for the number it was asked for.

const run = (state: PhoneOtpState, ...events: PhoneOtpEvent[]) => events.reduce(phoneOtpReducer, state);
const start = (kind: 'send' | 'verify', id: number, phone: string): PhoneOtpEvent => ({ type: 'request_started', id, kind, phone });

describe('the happy path', () => {
  it('send → code box → verify → verified', () => {
    let s = run(initialPhoneOtpState('9876543210'), start('send', 1, '9876543210'));
    expect(phoneOtpBusy(s)).toBe(true);
    s = run(s, { type: 'request_succeeded', id: 1 });
    expect(s.step).toBe('sent');
    expect(phoneOtpBusy(s)).toBe(false);
    s = run(s, { type: 'code_changed', value: '123456' }, start('verify', 2, '9876543210'), { type: 'request_succeeded', id: 2 });
    expect(s).toMatchObject({ verified: true, step: 'idle', code: '', pending: null });
  });

  it('a failure shows its message and frees the buttons', () => {
    const s = run(initialPhoneOtpState('9876543210'), start('send', 1, '9876543210'), {
      type: 'request_failed',
      id: 1,
      message: 'Could not send the verification code.',
    });
    expect(s).toMatchObject({ step: 'idle', error: 'Could not send the verification code.', pending: null });
  });
});

describe('the re-lock and stale answers', () => {
  it('editing the number un-verifies it', () => {
    const verified: PhoneOtpState = { ...initialPhoneOtpState('9876543210'), verified: true };
    expect(run(verified, { type: 'phone_changed', value: '9123456789' })).toMatchObject({ verified: false, step: 'idle' });
  });

  it('a verify answering after the number was edited does NOT verify the new number (the bug)', () => {
    let s = run(
      { ...initialPhoneOtpState('9876543210'), step: 'sent', code: '123456' },
      start('verify', 7, '9876543210'),
      { type: 'phone_changed', value: '9123456789' },
    );
    expect(otpReplyApplies(s, 7)).toBe(false);
    s = run(s, { type: 'request_succeeded', id: 7 });
    expect(s.verified).toBe(false);
    expect(s.phone).toBe('9123456789');
    expect(phoneOtpBusy(s)).toBe(false); // the buttons come back for the new number
  });

  it('a send answering after the number was edited does not open the code box', () => {
    const s = run(initialPhoneOtpState('9876543210'), start('send', 3, '9876543210'), { type: 'phone_changed', value: '9123456789' }, {
      type: 'request_succeeded',
      id: 3,
    });
    expect(s.step).toBe('idle');
  });

  it("a stale failure doesn't show an error against the new number", () => {
    const s = run(initialPhoneOtpState('9876543210'), start('send', 3, '9876543210'), { type: 'phone_changed', value: '9123456789' }, {
      type: 'request_failed',
      id: 3,
      message: 'Rate limited',
    });
    expect(s.error).toBeNull();
  });

  it('re-typing the same number differently still counts as the same number', () => {
    expect(samePhoneNumber('98765 43210', '9876543210')).toBe(true);
    expect(samePhoneNumber('+91 98765 43210', '9876543210')).toBe(true);
    const s = run(initialPhoneOtpState('98765 43210'), start('verify', 4, '98765 43210'), { type: 'phone_changed', value: '9876543210' }, {
      type: 'request_succeeded',
      id: 4,
    });
    expect(s.verified).toBe(true);
  });

  it('one request at a time; an answer for another id is ignored', () => {
    const busy = run(initialPhoneOtpState('9876543210'), start('send', 1, '9876543210'));
    expect(run(busy, start('send', 2, '9876543210'))).toBe(busy);
    expect(run(busy, { type: 'request_succeeded', id: 99 })).toBe(busy);
  });

  it('prefill only fills an empty field', () => {
    expect(run(initialPhoneOtpState(''), { type: 'prefill', value: '9876543210' }).phone).toBe('9876543210');
    expect(run(initialPhoneOtpState('91234'), { type: 'prefill', value: '9876543210' }).phone).toBe('91234');
  });
});

describe('the hook and the Profile page use it', () => {
  it('usePhoneOtp captures the number at call time and only fires onVerified for it', () => {
    const hook = readFileSync('lib/hooks/usePhoneOtp.ts', 'utf8');
    expect(hook).toContain('useReducer(phoneOtpReducer');
    expect(hook).toContain('const asked = phoneRef.current;');
    expect(hook).toContain("if (kind === 'verify' && samePhoneNumber(asked, phoneRef.current))");
  });

  it('the Profile page no longer re-implements the link flow', () => {
    const profile = readFileSync('app/account/profile/page.tsx', 'utf8');
    expect(profile).toContain('usePhoneOtp({');
    expect(profile).toContain('linkToAccount: true');
    // Its own updateUser({ phone }) / verifyOtp(phone_change) calls are gone (the email flow keeps its own).
    expect(profile).not.toContain("type: 'phone_change',");
    expect(profile).not.toContain('updateUser({ phone:');
  });
});
