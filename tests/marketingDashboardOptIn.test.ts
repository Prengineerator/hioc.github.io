import { describe, expect, it } from 'vitest';
import { chooseOptInMode, classifyMe, usableWaLink } from '@/components/marketing/optInLogic';

const WA = 'https://wa.me/919876543210?text=START';

describe('which opt-in card the order page shows', () => {
  it('asks a signed-in customer with a verified phone, with one tap', () => {
    expect(classifyMe({ phone: '+919876543210', phone_verified: true, marketing_consent: false })).toBe('ask');
    expect(chooseOptInMode('ask', null)).toBe('profile');
    // …even when a WhatsApp link is also available: the profile path is the better one.
    expect(chooseOptInMode('ask', { available: true, wa_link: WA })).toBe('profile');
  });

  it('says nothing to someone who already opted in', () => {
    expect(classifyMe({ phone: '+919876543210', phone_verified: true, marketing_consent: true })).toBe('already_in');
    expect(chooseOptInMode('already_in', { available: true, wa_link: WA })).toBe('none');
  });

  it('never treats an unverified or missing phone as consent-able through the profile', () => {
    expect(classifyMe({ phone: '+919876543210', phone_verified: false, marketing_consent: false })).toBe('no_profile_path');
    expect(classifyMe({ phone: '', phone_verified: true, marketing_consent: false })).toBe('no_profile_path');
    expect(classifyMe({ phone_verified: true })).toBe('no_profile_path');
    expect(classifyMe({ phone: '+919876543210', phone_verified: 'true' })).toBe('no_profile_path');
  });

  it('gives everyone else the WhatsApp link, and nothing when there is none', () => {
    expect(classifyMe(null)).toBe('no_profile_path'); // a guest (401) or a failed request
    expect(classifyMe(undefined)).toBe('no_profile_path');
    expect(chooseOptInMode('no_profile_path', { available: true, wa_link: WA })).toBe('wa_link');
    expect(chooseOptInMode('no_profile_path', { available: false, wa_link: null })).toBe('none');
    expect(chooseOptInMode('no_profile_path', null)).toBe('none');
  });
});

describe('the WhatsApp link is only ever a real wa.me link', () => {
  it('accepts the link the server builds', () => {
    expect(usableWaLink({ available: true, wa_link: WA })).toBe(WA);
    expect(usableWaLink({ available: true, wa_link: 'https://wa.me/919876543210' })).toBe('https://wa.me/919876543210');
  });

  it('refuses anything else, because it goes straight into an href', () => {
    expect(usableWaLink({ available: false, wa_link: WA })).toBeNull();
    expect(usableWaLink({ available: true, wa_link: null })).toBeNull();
    expect(usableWaLink({ available: true, wa_link: 'javascript:alert(1)' })).toBeNull();
    expect(usableWaLink({ available: true, wa_link: 'http://wa.me/919876543210?text=START' })).toBeNull();
    expect(usableWaLink({ available: true, wa_link: 'https://evil.example/https://wa.me/919876543210' })).toBeNull();
    expect(usableWaLink({ available: true, wa_link: 'https://wa.me/abc' })).toBeNull();
    expect(usableWaLink(null)).toBeNull();
  });
});
