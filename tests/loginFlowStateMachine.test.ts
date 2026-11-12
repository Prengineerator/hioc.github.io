import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_LOGIN_FLOW,
  loginFlowReducer,
  loginLocked,
  loginRequestMode,
  type LoginFlowEvent,
  type LoginFlowState,
} from '@/app/login/loginFlow';

// The customer login form (app/login/loginFlow.ts): one request at a time, no
// tab switch under one, and the code checked against where it was sent.

const run = (state: LoginFlowState, ...events: LoginFlowEvent[]) => events.reduce(loginFlowReducer, state);

describe('login flow', () => {
  it('WhatsApp: send → code → verify → signed in (locked while navigating away)', () => {
    let s = run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_request', target: '9876543210' });
    expect(loginLocked(s)).toBe(true);
    s = run(s, { type: 'request_succeeded', id: 1 });
    expect(s).toMatchObject({ phoneStep: 'code', phoneSentTo: '9876543210', pending: null });
    s = run(s, { type: 'request_started', id: 2, request: 'phone_verify', target: '9876543210' }, { type: 'request_succeeded', id: 2 });
    expect(s.signedIn).toBe(true);
    expect(loginLocked(s)).toBe(true);
  });

  it('no tab switch while a request is out (a late answer used to flip the other tab to "code")', () => {
    const sending = run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_request', target: '9876543210' });
    expect(run(sending, { type: 'switch_mode', mode: 'otp' })).toBe(sending);
    expect(run(sending, { type: 'back_to_entry' })).toBe(sending);
  });

  it('one request at a time (a double Enter sent two WhatsApp messages)', () => {
    const sending = run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_request', target: '9876543210' });
    expect(run(sending, { type: 'request_started', id: 2, request: 'phone_request', target: '9876543210' })).toBe(sending);
  });

  it('the number the code went to is the one checked, even if the field was edited while sending', () => {
    const s = run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_request', target: '9876543210' }, {
      type: 'request_succeeded',
      id: 1,
    });
    expect(s.phoneSentTo).toBe('9876543210');
    const src = readFileSync('app/login/LoginForm.tsx', 'utf8');
    expect(src).toContain('const target = flow.phoneSentTo;');
    expect(src).toContain('const target = flow.emailSentTo;');
  });

  it('a request only starts from the tab and step that offer it', () => {
    expect(run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'email_request', target: 'a@b.c' })).toBe(INITIAL_LOGIN_FLOW);
    expect(run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_verify', target: 'x' })).toBe(INITIAL_LOGIN_FLOW);
  });

  it('a failure frees the form; switching tab resets both steps', () => {
    let s = run(INITIAL_LOGIN_FLOW, { type: 'request_started', id: 1, request: 'phone_request', target: '1' }, { type: 'request_failed', id: 1 });
    expect(loginLocked(s)).toBe(false);
    expect(s.phoneStep).toBe('phone');
    s = run(s, { type: 'switch_mode', mode: 'otp' });
    expect(s).toMatchObject({ mode: 'otp', emailStep: 'email', phoneStep: 'phone' });
  });

  it('requests belong to their tab', () => {
    expect(loginRequestMode('phone_request')).toBe('phone');
    expect(loginRequestMode('phone_verify')).toBe('phone');
    expect(loginRequestMode('email_request')).toBe('otp');
    expect(loginRequestMode('email_verify')).toBe('otp');
  });

  it('the tab buttons and "use a different…" links are disabled while locked', () => {
    const src = readFileSync('app/login/LoginForm.tsx', 'utf8');
    expect(src.match(/onClick=\{\(\) => switchMode\('(phone|otp)'\)\}\s*disabled=\{submitting\}/g)).toHaveLength(2);
    expect(src.match(/onClick=\{backToEntry\}\s*disabled=\{submitting\}/g)).toHaveLength(2);
  });
});
