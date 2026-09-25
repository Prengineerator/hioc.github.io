import { afterEach, describe, expect, it } from 'vitest';
import {
  formatFeedbackButtonPayload,
  parseFeedbackButtonPayload,
  ratingFromButtonText,
  isOptOutKeyword,
  FEEDBACK_BUTTONS,
} from '@/lib/feedback/payload';
import {
  computeScheduledFor,
  withinCustomerServiceWindow,
  templateResendAllowed,
  withinEditWindow,
} from '@/lib/feedback/window';
import { hashFeedbackToken, looksLikeFeedbackToken, newFeedbackToken } from '@/lib/feedback/token';
import { resolveGoogleReviewUrl } from '@/lib/feedback/reviewLink';
import { GOOGLE_REVIEW_URL_DEFAULT } from '@/lib/constants';

describe('lib/feedback/payload', () => {
  it('round-trips a quick-reply payload', () => {
    const payload = formatFeedbackButtonPayload('req-123', 5);
    expect(payload).toBe('fb:req-123:5');
    expect(parseFeedbackButtonPayload(payload)).toEqual({ requestId: 'req-123', rating: 5 });
  });

  it('handles a uuid request id (contains no colon) correctly', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const payload = formatFeedbackButtonPayload(id, 1);
    expect(parseFeedbackButtonPayload(payload)).toEqual({ requestId: id, rating: 1 });
  });

  it('rejects malformed or unrecognised payloads', () => {
    expect(parseFeedbackButtonPayload(null)).toBeNull();
    expect(parseFeedbackButtonPayload(undefined)).toBeNull();
    expect(parseFeedbackButtonPayload('')).toBeNull();
    expect(parseFeedbackButtonPayload('not-a-payload')).toBeNull();
    expect(parseFeedbackButtonPayload('fb::5')).toBeNull(); // empty request id
    expect(parseFeedbackButtonPayload('fb:req-1:4')).toBeNull(); // 4 is not a valid rating
    expect(parseFeedbackButtonPayload('fb:req-1:')).toBeNull();
  });

  it('never trusts a payload beyond exactly what it parses to — no guessing', () => {
    // A payload for a DIFFERENT feature or a forged string must not resolve to
    // a rating just because it happens to contain digits.
    expect(parseFeedbackButtonPayload('order:req-1:5:extra')).toBeNull();
  });

  it('matches the exact configured button labels for the text fallback', () => {
    for (const b of FEEDBACK_BUTTONS) {
      expect(ratingFromButtonText(b.label)).toBe(b.rating);
    }
  });

  it('does not guess a rating from an unrelated or near-miss label', () => {
    expect(ratingFromButtonText('Loved it')).toBeNull(); // missing the emoji
    expect(ratingFromButtonText('😍 loved it')).toBeNull(); // case differs
    expect(ratingFromButtonText('random text')).toBeNull();
    expect(ratingFromButtonText(null)).toBeNull();
    expect(ratingFromButtonText(undefined)).toBeNull();
  });

  it('recognises STOP/UNSUBSCRIBE case-insensitively, trimmed', () => {
    expect(isOptOutKeyword('STOP')).toBe(true);
    expect(isOptOutKeyword('stop')).toBe(true);
    expect(isOptOutKeyword('  Stop  ')).toBe(true);
    expect(isOptOutKeyword('unsubscribe')).toBe(true);
    expect(isOptOutKeyword('UNSUBSCRIBE')).toBe(true);
    expect(isOptOutKeyword('please stop sending')).toBe(false);
    expect(isOptOutKeyword('')).toBe(false);
    expect(isOptOutKeyword(null)).toBe(false);
  });
});

describe('lib/feedback/window', () => {
  it('computeScheduledFor adds the configured delay in minutes', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(computeScheduledFor(at, 30).toISOString()).toBe('2026-01-01T00:30:00.000Z');
    expect(computeScheduledFor(at, 1).toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('withinCustomerServiceWindow is true under 24h, false at/after', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const at23h = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    const at24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const at25h = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    expect(withinCustomerServiceWindow(at23h, now)).toBe(true);
    expect(withinCustomerServiceWindow(at24h, now)).toBe(false);
    expect(withinCustomerServiceWindow(at25h, now)).toBe(false);
    expect(withinCustomerServiceWindow(null, now)).toBe(false);
  });

  it('templateResendAllowed mirrors the 24h rule but defaults to allowed', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    expect(templateResendAllowed(null, now)).toBe(true);
    expect(templateResendAllowed(new Date(now.getTime() - 25 * 60 * 60 * 1000), now)).toBe(true);
    expect(templateResendAllowed(new Date(now.getTime() - 1 * 60 * 60 * 1000), now)).toBe(false);
  });

  it('withinEditWindow allows edits for 7 days then expires', () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const at6d = new Date(created.getTime() + 6 * 24 * 60 * 60 * 1000);
    const at7d = new Date(created.getTime() + 7 * 24 * 60 * 60 * 1000);
    const at8d = new Date(created.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(withinEditWindow(created, at6d)).toBe(true);
    expect(withinEditWindow(created, at7d)).toBe(false);
    expect(withinEditWindow(created, at8d)).toBe(false);
  });
});

describe('lib/feedback/token', () => {
  it('newFeedbackToken produces distinct, base64url-safe tokens', () => {
    const a = newFeedbackToken();
    const b = newFeedbackToken();
    expect(a).not.toBe(b);
    expect(looksLikeFeedbackToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashFeedbackToken is deterministic and one-way-looking (sha256 hex)', () => {
    const token = 'a-fixed-test-token-value-1234567890';
    const hash1 = hashFeedbackToken(token);
    const hash2 = hashFeedbackToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash1).not.toBe(token);
  });

  it('looksLikeFeedbackToken rejects obviously-wrong input before it ever reaches a hash lookup', () => {
    expect(looksLikeFeedbackToken('')).toBe(false);
    expect(looksLikeFeedbackToken('short')).toBe(false);
    expect(looksLikeFeedbackToken('has spaces in it 1234567890')).toBe(false);
    expect(looksLikeFeedbackToken('../../etc/passwd')).toBe(false);
    expect(looksLikeFeedbackToken(newFeedbackToken())).toBe(true);
  });
});

describe('lib/feedback/reviewLink', () => {
  const ORIGINAL_ENV = process.env.GOOGLE_REVIEW_URL;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.GOOGLE_REVIEW_URL;
    else process.env.GOOGLE_REVIEW_URL = ORIGINAL_ENV;
  });

  it('prefers the env override when set', () => {
    process.env.GOOGLE_REVIEW_URL = 'https://example.com/env-review';
    expect(resolveGoogleReviewUrl('https://example.com/settings-review')).toBe('https://example.com/env-review');
  });

  it('falls back to the settings value when env is unset', () => {
    delete process.env.GOOGLE_REVIEW_URL;
    expect(resolveGoogleReviewUrl('https://example.com/settings-review')).toBe('https://example.com/settings-review');
  });

  it('falls back to the hardcoded default when both are empty', () => {
    delete process.env.GOOGLE_REVIEW_URL;
    expect(resolveGoogleReviewUrl('')).toBe(GOOGLE_REVIEW_URL_DEFAULT);
    expect(resolveGoogleReviewUrl(null)).toBe(GOOGLE_REVIEW_URL_DEFAULT);
    expect(resolveGoogleReviewUrl(undefined)).toBe(GOOGLE_REVIEW_URL_DEFAULT);
  });
});

