import { describe, expect, it } from 'vitest';
import {
  buildVars,
  firstName,
  formatShortDate,
  generateClickToken,
  renderPreview,
  sanitizeParam,
  templateValues,
  TEMPLATE_TOKENS,
} from '@/lib/marketing/templates';
import {
  CLICK_TOKEN_ALPHABET,
  DEFAULT_PLAYBOOKS,
  DEFAULT_TEMPLATES,
  TEMPLATE_TOKEN_SAMPLES,
} from '@/lib/marketing/types';

describe('TEMPLATE_TOKENS', () => {
  it('is the spec §5 list, in order', () => {
    expect([...TEMPLATE_TOKENS]).toEqual([
      'first_name', 'points', 'points_value_inr', 'expiring_points', 'expiring_value_inr',
      'expiry_date', 'offer_text', 'code', 'valid_till', 'days_since_visit', 'headline',
    ]);
  });

  it('has a sample value for every token', () => {
    for (const t of TEMPLATE_TOKENS) expect(TEMPLATE_TOKEN_SAMPLES[t]).toBeTruthy();
  });
});

describe('firstName', () => {
  it('is the first word of the name', () => {
    expect(firstName('Asha Rao')).toBe('Asha');
    expect(firstName('  priya   sharma ')).toBe('priya');
    expect(firstName('Madonna')).toBe('Madonna');
  });

  it('falls back to "there" when there is nothing usable', () => {
    expect(firstName(null)).toBe('there');
    expect(firstName(undefined)).toBe('there');
    expect(firstName('')).toBe('there');
    expect(firstName('   ')).toBe('there');
  });

  it('a name that is really a phone number becomes "there"', () => {
    expect(firstName('9876543210')).toBe('there');
    expect(firstName('+91 98765 43210')).toBe('there');
    expect(firstName('98765-43210')).toBe('there');
  });

  it('a name with digits and letters is kept', () => {
    expect(firstName('2Pac Shakur')).toBe('2Pac');
  });

  it('is capped at 20 characters', () => {
    expect(firstName('Wolfeschlegelsteinhausenbergerdorff Jr')).toBe('Wolfeschlegelsteinha');
    expect(firstName('Wolfeschlegelsteinha').length).toBe(20);
  });

  it('does not split an emoji when cutting', () => {
    const name = '😀'.repeat(25);
    const first = firstName(name);
    expect(Array.from(first)).toHaveLength(20);
    expect(first).toBe('😀'.repeat(20));
  });

  it('newlines and tabs are whitespace, not part of the name', () => {
    expect(firstName('Asha\nRao')).toBe('Asha');
    expect(firstName('\tAsha')).toBe('Asha');
  });
});

describe('sanitizeParam (spec §5)', () => {
  it('leaves an already clean value alone', () => {
    expect(sanitizeParam('10% off (up to ₹60) on orders above ₹150')).toBe('10% off (up to ₹60) on orders above ₹150');
  });

  it('strips newlines, carriage returns and tabs (Meta rejects them) — leaving a space so words do not fuse', () => {
    expect(sanitizeParam('Hello\nWorld')).toBe('Hello World');
    expect(sanitizeParam('a\r\nb')).toBe('a b');
    expect(sanitizeParam('a\tb')).toBe('a b');
    expect(sanitizeParam('a\n\n\nb')).toBe('a b');
  });

  it('collapses runs of spaces', () => {
    expect(sanitizeParam('a     b')).toBe('a b');
    expect(sanitizeParam('a  \n  b')).toBe('a b');
  });

  it('trims', () => {
    expect(sanitizeParam('  hi  ')).toBe('hi');
    expect(sanitizeParam('\n hi \t')).toBe('hi');
  });

  it('caps at 100 characters', () => {
    expect(sanitizeParam('x'.repeat(150))).toHaveLength(100);
    expect(sanitizeParam('x'.repeat(100))).toHaveLength(100);
  });

  it('does not leave a trailing space after the cut', () => {
    const v = 'x'.repeat(99) + ' tail';
    expect(sanitizeParam(v)).toBe('x'.repeat(99));
  });

  it('does not split an emoji at the cap', () => {
    const out = sanitizeParam('😀'.repeat(150));
    expect(Array.from(out)).toHaveLength(100);
  });

  it('an empty result becomes "-" (an empty parameter is rejected)', () => {
    expect(sanitizeParam('')).toBe('-');
    expect(sanitizeParam('   ')).toBe('-');
    expect(sanitizeParam('\n\t\r')).toBe('-');
    expect(sanitizeParam(null)).toBe('-');
    expect(sanitizeParam(undefined)).toBe('-');
  });

  it('coerces numbers', () => {
    expect(sanitizeParam(80)).toBe('80');
    expect(sanitizeParam(0)).toBe('0');
  });
});

describe('formatShortDate', () => {
  it('is "5 Oct": day without a leading zero, English month, no year', () => {
    expect(formatShortDate('2026-10-05T06:00:00Z')).toBe('5 Oct');
    expect(formatShortDate('2026-10-12T06:00:00Z')).toBe('12 Oct');
    expect(formatShortDate('2026-01-01T06:00:00Z')).toBe('1 Jan');
    expect(formatShortDate('2026-12-31T06:00:00Z')).toBe('31 Dec');
  });

  it('reads the IST day, not the UTC one', () => {
    expect(formatShortDate('2026-10-04T19:00:00Z')).toBe('5 Oct'); // 00:30 IST on the 5th
    expect(formatShortDate('2026-10-05T18:29:59.999Z')).toBe('5 Oct'); // last ms of the 5th IST
    expect(formatShortDate('2026-10-05T18:30:00Z')).toBe('6 Oct');
  });

  it('accepts Dates and epoch milliseconds', () => {
    expect(formatShortDate(new Date('2026-10-05T06:00:00Z'))).toBe('5 Oct');
    expect(formatShortDate(Date.parse('2026-10-05T06:00:00Z'))).toBe('5 Oct');
  });

  it('is empty for an unparseable date', () => {
    expect(formatShortDate('not a date')).toBe('');
  });
});

describe('templateValues', () => {
  it('formats plan-time facts into token strings', () => {
    const v = templateValues({
      name: 'Asha Rao',
      points: 120,
      points_value_inr: 120,
      expiring_points: 80,
      expiring_value_inr: 80,
      expiry_date: '2026-10-05T06:00:00Z',
      days_since_visit: 32,
    });
    expect(v).toEqual({
      first_name: 'Asha',
      points: '120',
      points_value_inr: '120',
      expiring_points: '80',
      expiring_value_inr: '80',
      expiry_date: '5 Oct',
      days_since_visit: '32',
    });
  });

  it('formats send-time facts too (code, valid_till, offer_text)', () => {
    const v = templateValues({ offer_text: '10% off', code: 'WBK7M3QX', valid_till: '2026-10-15T18:29:59.999Z' });
    expect(v).toEqual({ offer_text: '10% off', code: 'WBK7M3QX', valid_till: '15 Oct' });
  });

  it('omits what was not supplied and rounds numbers to whole values', () => {
    expect(templateValues({})).toEqual({});
    expect(templateValues({ points: 79.6 }).points).toBe('80');
    expect(templateValues({ points: -3 }).points).toBe('0');
  });

  it('the headline is flattened and capped at 60 characters', () => {
    expect(templateValues({ headline: 'New\nlatte' }).headline).toBe('New latte');
    expect(templateValues({ headline: 'x'.repeat(90) }).headline).toHaveLength(60);
  });

  it('a nameless customer is "there"', () => {
    expect(templateValues({ name: null }).first_name).toBe('there');
  });
});

describe('buildVars', () => {
  it('returns one sanitised string per token, in the owner’s order', () => {
    const vars = buildVars(['first_name', 'code', 'valid_till'], { valid_till: '15 Oct', first_name: 'Asha', code: 'WBK7M3QX' });
    expect(vars).toEqual(['Asha', 'WBK7M3QX', '15 Oct']);
  });

  it('a missing token becomes "-" and keeps its slot (dropping it would shift every later {{n}})', () => {
    expect(buildVars(['first_name', 'code', 'valid_till'], { first_name: 'Asha', valid_till: '15 Oct' })).toEqual(['Asha', '-', '15 Oct']);
  });

  it('sanitises every value', () => {
    expect(buildVars(['offer_text'], { offer_text: 'a\nFREE   coffee' })).toEqual(['a FREE coffee']);
    expect(buildVars(['headline'], { headline: '' })).toEqual(['-']);
  });

  it('the same token may fill several slots', () => {
    expect(buildVars(['first_name', 'first_name'], { first_name: 'Asha' })).toEqual(['Asha', 'Asha']);
  });

  it('no tokens, no vars', () => {
    expect(buildVars([], { first_name: 'Asha' })).toEqual([]);
  });

  it('the default win-back template produces exactly the 4 parameters its body expects', () => {
    const t = DEFAULT_PLAYBOOKS.winback_1.template;
    const vars = buildVars(t.vars, templateValues({ name: 'Asha', offer_text: '10% off (up to ₹60) on orders above ₹150', code: 'WBK7M3QX', valid_till: '2026-10-15T09:00:00Z' }));
    expect(vars).toHaveLength(4);
    expect(renderPreview(t.body_preview, vars)).toBe(
      "Hi Asha, we've missed you at HIOC! Here's 10% off (up to ₹60) on orders above ₹150 on your next visit. Use code WBK7M3QX at the counter or online, valid till 15 Oct. Your favourites are waiting!",
    );
  });
});

describe('renderPreview', () => {
  it('substitutes {{n}} with the 1-based parameter', () => {
    expect(renderPreview('Hi {{1}}, code {{2}}', ['Asha', 'WB1'])).toBe('Hi Asha, code WB1');
  });

  it('substitutes every occurrence and out-of-order placeholders', () => {
    expect(renderPreview('{{2}} then {{1}} then {{2}}', ['a', 'b'])).toBe('b then a then b');
  });

  it('leaves a placeholder with no parameter visible', () => {
    expect(renderPreview('Hi {{1}} {{3}}', ['Asha'])).toBe('Hi Asha {{3}}');
  });

  it('tolerates spaces inside the braces', () => {
    expect(renderPreview('Hi {{ 1 }}', ['Asha'])).toBe('Hi Asha');
  });

  it('is a no-op without placeholders and with an empty body', () => {
    expect(renderPreview('plain', ['x'])).toBe('plain');
    expect(renderPreview('', ['x'])).toBe('');
  });

  it('does not re-expand a value that itself contains braces', () => {
    expect(renderPreview('Hi {{1}}', ['{{2}}', 'X'])).toBe('Hi {{2}}');
  });

  it('renders every default template with its own sample values with no placeholder left over', () => {
    for (const t of Object.values(DEFAULT_TEMPLATES)) {
      const vars = t.vars.map((tok) => TEMPLATE_TOKEN_SAMPLES[tok]);
      const out = renderPreview(t.body_preview, vars);
      expect(out).not.toMatch(/\{\{\d+\}\}/);
      // Body placeholders are exactly 1..vars.length — a default template can never mismatch Meta's parameter count.
      const nums = [...t.body_preview.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(new Set(nums)).toEqual(new Set(t.vars.map((_, i) => i + 1)));
    }
  });
});

describe('generateClickToken', () => {
  it('is 12 base64url characters', () => {
    const t = generateClickToken(() => 0.5);
    expect(t).toHaveLength(12);
    expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('is deterministic for an injected RNG and clamps a stray 1', () => {
    expect(generateClickToken(() => 0)).toBe('A'.repeat(12));
    expect(generateClickToken(() => 1)).toBe('_'.repeat(12));
    expect(CLICK_TOKEN_ALPHABET).toHaveLength(64);
  });
});
