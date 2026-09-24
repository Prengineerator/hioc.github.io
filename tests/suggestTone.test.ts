import { describe, expect, it } from 'vitest';
import { BANNED_PHRASES, lintReason, sanitizeNote } from '@/lib/suggest/tone';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';

describe('lintReason', () => {
  it('accepts a warm, on-tone reason', () => {
    expect(lintReason('A lovely pick — bold and smooth, a good lift when you need the energy.')).toEqual({
      ok: true,
    });
  });

  it('rejects an empty or whitespace-only reason', () => {
    expect(lintReason('').ok).toBe(false);
    expect(lintReason('   ').ok).toBe(false);
  });

  it('rejects a reason longer than SUGGEST_LIMITS.reasonMaxChars', () => {
    const long = 'a'.repeat(SUGGEST_LIMITS.reasonMaxChars + 1);
    expect(lintReason(long).ok).toBe(false);
    expect(lintReason('a'.repeat(SUGGEST_LIMITS.reasonMaxChars)).ok).toBe(true);
  });

  it('rejects HTML angle brackets', () => {
    expect(lintReason('A lovely pick <b>today</b>.').ok).toBe(false);
  });

  it('rejects URLs', () => {
    expect(lintReason('See https://hioc.example for more.').ok).toBe(false);
    expect(lintReason('Visit www.hioc.example today.').ok).toBe(false);
  });

  it('allows exactly one emoji but rejects two or more', () => {
    expect(lintReason('A lovely pick for you ☕.').ok).toBe(true);
    expect(lintReason('A lovely pick for you ☕🎉.').ok).toBe(false);
  });

  // §6.1 requirement: lintReason rejects every banned phrase in §4.
  it.each(BANNED_PHRASES)('rejects the banned phrase "%s"', (phrase) => {
    const result = lintReason(`This is a reason that mentions ${phrase} in passing.`);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe(`banned_phrase:${phrase}`);
  });

  it('matches banned phrases case-insensitively', () => {
    expect(lintReason('You SHOULD try this one.').ok).toBe(false);
  });

  it('matches banned phrases word-boundary-aware (no false positive on a substring)', () => {
    // "spend" is banned; "suspended" and "spendthrift" must NOT trip it.
    expect(lintReason('Service is temporarily suspended today.').ok).toBe(true);
  });

  it('flags every literal example given in §4 "Never"', () => {
    expect(lintReason('Since you spend a lot, treat yourself.').ok).toBe(false);
    expect(lintReason('You always order this, so here it is.').ok).toBe(false);
    expect(lintReason("Hurry, don't miss this only today.").ok).toBe(false);
    expect(lintReason('This is the best deal in town.').ok).toBe(false);
    expect(lintReason('A healthy pick that boosts immunity.').ok).toBe(false);
    expect(lintReason('This is good for stress.').ok).toBe(false);
    expect(lintReason('You seem sad today.').ok).toBe(false);
  });
});

describe('sanitizeNote', () => {
  it('trims and collapses internal whitespace', () => {
    expect(sanitizeNote('  meeting   a friend  ')).toBe('meeting a friend');
  });

  it('strips control characters and angle brackets', () => {
    expect(sanitizeNote('hello\u0000<script>world')).toBe('helloscriptworld');
  });

  it('caps at SUGGEST_LIMITS.noteMaxChars', () => {
    const long = 'x'.repeat(SUGGEST_LIMITS.noteMaxChars + 50);
    expect(sanitizeNote(long).length).toBe(SUGGEST_LIMITS.noteMaxChars);
  });

  it('handles an empty/undefined-ish input safely', () => {
    expect(sanitizeNote('')).toBe('');
  });
});
