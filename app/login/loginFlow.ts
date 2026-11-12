// The customer login form's state (app/login/LoginForm.tsx), as a pure reducer
// so it is unit-tested without a renderer.
//
//   WhatsApp:  phone ──send──▶ code ──verify──▶ signed in (navigating away)
//   Email:     email ──send──▶ code ──verify──▶ signed in
//   Switching tab, or "Use a different number/email", goes back to the first step.
//
// One request at a time, and nothing moves under one. It was one `submitting`
// flag with the tab switch and the "use a different…" links always live: a
// code request answering after the customer switched tab flipped the OTHER
// tab's step to "code" and showed "We sent a code to …" on a screen that had
// sent nothing, and an Enter pressed twice before the re-render sent two
// WhatsApp messages. And the code was checked against whatever the number field
// said at verify time, not the number it was sent to; now it is checked
// against the number (or address) the code actually went to.

export type LoginMode = 'phone' | 'otp';
export type LoginRequest = 'phone_request' | 'phone_verify' | 'email_request' | 'email_verify';

export interface LoginFlowState {
  mode: LoginMode;
  emailStep: 'email' | 'code';
  phoneStep: 'phone' | 'code';
  /** Where the last code went, as it was sent. The verify step uses these. */
  emailSentTo: string;
  phoneSentTo: string;
  /** The request in flight, if any. */
  pending: { id: number; request: LoginRequest } | null;
  /** A code checked out: the page is navigating away, so nothing is live. */
  signedIn: boolean;
}

export type LoginFlowEvent =
  | { type: 'switch_mode'; mode: LoginMode }
  | { type: 'back_to_entry' }
  | { type: 'request_started'; id: number; request: LoginRequest; target: string }
  | { type: 'request_succeeded'; id: number }
  | { type: 'request_failed'; id: number };

export const INITIAL_LOGIN_FLOW: LoginFlowState = {
  // WhatsApp is the default (and first-offered) way in.
  mode: 'phone',
  emailStep: 'email',
  phoneStep: 'phone',
  emailSentTo: '',
  phoneSentTo: '',
  pending: null,
  signedIn: false,
};

/** Which tab a request belongs to. */
export function loginRequestMode(request: LoginRequest): LoginMode {
  return request === 'phone_request' || request === 'phone_verify' ? 'phone' : 'otp';
}

/** Every control that would start or redirect a request is off. */
export function loginLocked(state: Pick<LoginFlowState, 'pending' | 'signedIn'>): boolean {
  return state.pending !== null || state.signedIn;
}

export function loginFlowReducer(state: LoginFlowState, event: LoginFlowEvent): LoginFlowState {
  switch (event.type) {
    case 'switch_mode':
      if (loginLocked(state)) return state;
      return { ...state, mode: event.mode, emailStep: 'email', phoneStep: 'phone' };
    case 'back_to_entry':
      if (loginLocked(state)) return state;
      return state.mode === 'phone' ? { ...state, phoneStep: 'phone' } : { ...state, emailStep: 'email' };
    case 'request_started': {
      if (loginLocked(state)) return state;
      // A request only starts from the tab and step that offer it.
      if (loginRequestMode(event.request) !== state.mode) return state;
      const pending = { id: event.id, request: event.request };
      switch (event.request) {
        case 'phone_request':
          return state.phoneStep === 'phone' ? { ...state, pending, phoneSentTo: event.target } : state;
        case 'email_request':
          return state.emailStep === 'email' ? { ...state, pending, emailSentTo: event.target } : state;
        case 'phone_verify':
          return state.phoneStep === 'code' ? { ...state, pending } : state;
        case 'email_verify':
          return state.emailStep === 'code' ? { ...state, pending } : state;
      }
    }
    case 'request_succeeded': {
      if (!state.pending || state.pending.id !== event.id) return state;
      const settled = { ...state, pending: null };
      switch (state.pending.request) {
        case 'phone_request':
          return { ...settled, phoneStep: 'code' };
        case 'email_request':
          return { ...settled, emailStep: 'code' };
        default:
          return { ...settled, signedIn: true };
      }
    }
    case 'request_failed':
      if (!state.pending || state.pending.id !== event.id) return state;
      return { ...state, pending: null };
  }
}
