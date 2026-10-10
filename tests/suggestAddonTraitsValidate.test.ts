import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — the validator
// behind PATCH /api/owner/suggest/addon-traits: what the owner may store as the
// override of ONE add-on option. Pure. Each rule mirrors a named CHECK in
// supabase/2026-10-coffey-addons-pairings.sql, and this file reads that SQL (the
// way tests/suggestTraitsV2Migration.test.ts does) and sweeps the validator
// against what the database itself would accept, so the two cannot drift apart
// unnoticed.

import { deriveAddonTraits } from '@/lib/suggest/addonTraits';
import {
  ADDON_FAMILIES_MAX,
  ADDON_INDULGENCE_DELTA_MAX,
  ADDON_INTENSITY_DELTA_MAX,
  ADDON_PATCH_KEYS,
  ADDON_SWEETNESS_DELTA_MAX,
  ADDON_TEXTURES_MAX,
  isAddonOptionId,
  validateAddonTraitsPatch,
} from '@/lib/suggest/addonTraitsValidate';
import { TEXTURES } from '@/lib/suggest/traitVocabulary';
import { ADDON_ROLES, FLAVOUR_FAMILIES, type AddonTraits } from '@/lib/suggest/types';

const OPTION_ID = '3dd077ea-b036-58f0-9a3b-dab3746e894c';

const VALID = {
  optionId: OPTION_ID,
  role: 'flavour',
  flavour_families: ['nutty'],
  sweetness_delta: 2,
  intensity_delta: 0,
  indulgence_delta: 1,
  textures: ['creamy'],
};

/** A valid body with some fields replaced (or removed, with `undefined`). */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...VALID, ...over };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

const verdict = (over: Record<string, unknown> = {}) => validateAddonTraitsPatch(body(over));

/** The traits when the body is accepted; fails the test otherwise. */
function accepted(over: Record<string, unknown> = {}): AddonTraits {
  const result = verdict(over);
  if (typeof result === 'string') throw new Error(`expected the body to be accepted, got: ${result}`);
  return result.traits;
}

// ---------------------------------------------------------------------------
// The SQL, read the way the migration test reads it
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'supabase/2026-10-coffey-addons-pairings.sql'), 'utf8');
// Comments would otherwise match (the header quotes some of these statements).
const code = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

/** The statement that adds the named constraint, up to its semicolon. */
function constraintStatement(name: string): string {
  const match = new RegExp(`add constraint ${name}\\b([\\s\\S]*?);`, 'i').exec(code);
  if (!match) throw new Error(`no "add constraint ${name}" in the migration`);
  return match[1];
}

const quoted = (text: string): string[] => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/** [min, max] from a `<column> between a and b` check. */
function betweenBounds(column: string): [number, number] {
  const match = new RegExp(`${column} between (-?\\d+) and (-?\\d+)\\b`).exec(constraintStatement(`addon_option_traits_${column}_check`));
  if (!match) throw new Error(`no "between" bounds for ${column}`);
  return [Number(match[1]), Number(match[2])];
}

/** The `cardinality(<column>) <= n` cap of a list check. */
function cardinalityCap(column: string): number {
  const match = new RegExp(`cardinality\\(${column}\\)\\s*<=\\s*(\\d+)`).exec(constraintStatement(`addon_option_traits_${column}_check`));
  if (!match) throw new Error(`no cardinality cap for ${column}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------

describe('the accepted body', () => {
  it('returns the option id and the traits, with nothing else', () => {
    expect(verdict()).toEqual({
      optionId: OPTION_ID,
      traits: {
        role: 'flavour',
        flavour_families: ['nutty'],
        sweetness_delta: 2,
        intensity_delta: 0,
        indulgence_delta: 1,
        textures: ['creamy'],
      },
    });
  });

  it('names exactly the seven keys the editor sends', () => {
    expect([...ADDON_PATCH_KEYS]).toEqual(['optionId', 'role', 'flavour_families', 'sweetness_delta', 'intensity_delta', 'indulgence_delta', 'textures']);
    expect(Object.keys(VALID)).toEqual([...ADDON_PATCH_KEYS]);
  });

  it('does not alias the arrays it was given', () => {
    const families = ['nutty'];
    const textures = ['creamy'];
    const traits = accepted({ flavour_families: families, textures });
    expect(traits.flavour_families).not.toBe(families);
    expect(traits.textures).not.toBe(textures);
  });
});

describe('the body itself', () => {
  it.each([null, undefined, 'x', 42, true, [], [VALID]])('rejects %j (not a JSON object)', (bad) => {
    expect(validateAddonTraitsPatch(bad)).toBe('Request body must be a JSON object');
  });

  it('rejects an object that is not a plain one', () => {
    expect(validateAddonTraitsPatch(new Date())).toBe('Request body must be a JSON object');
    expect(validateAddonTraitsPatch(new Map())).toBe('Request body must be a JSON object');
  });

  it('rejects an empty object, naming the id first', () => {
    expect(validateAddonTraitsPatch({})).toBe('A valid option id is required');
  });
});

describe('unknown keys are rejected', () => {
  it.each(['source', 'confirmed', 'updated_at', 'option_id', 'id', 'traits_version', 'Role', 'optionID'])('rejects "%s"', (key) => {
    const result = verdict({ [key]: 'x' });
    expect(result).toBe(`Unknown field "${key}"`);
  });

  it('rejects the prototype key a JSON body can carry', () => {
    const parsed = JSON.parse(`{"__proto__": {"role": "other"}, ${JSON.stringify(VALID).slice(1)}`);
    expect(typeof validateAddonTraitsPatch(parsed)).toBe('string');
  });

  it('does not echo a key that is long or has odd characters', () => {
    expect(verdict({ ['x'.repeat(41)]: 1 })).toBe('Unknown field in request');
    expect(verdict({ '<script>': 1 })).toBe('Unknown field in request');
  });

  it('refuses an unknown key even when every other field is fine', () => {
    expect(typeof verdict({ extra: true })).toBe('string');
  });
});

describe('every field is required (the route upserts the whole row)', () => {
  it.each(ADDON_PATCH_KEYS.filter((k) => k !== 'optionId'))('rejects a body without "%s"', (key) => {
    expect(verdict({ [key]: undefined })).toBe(`Missing value for "${key}"`);
  });

  it('rejects a body without the option id', () => {
    expect(verdict({ optionId: undefined })).toBe('A valid option id is required');
  });

  it('treats null as a present-but-invalid value', () => {
    for (const key of ADDON_PATCH_KEYS.filter((k) => k !== 'optionId')) {
      expect(verdict({ [key]: null }), key).toBe(`Invalid value for "${key}"`);
    }
  });
});

describe('optionId: a UUID', () => {
  it('accepts a UUID in either case', () => {
    expect(isAddonOptionId(OPTION_ID)).toBe(true);
    expect(verdict({ optionId: OPTION_ID.toUpperCase() })).toMatchObject({ optionId: OPTION_ID.toUpperCase() });
  });

  it.each(['', 'not-a-uuid', OPTION_ID.slice(1), `${OPTION_ID}0`, ` ${OPTION_ID}`, `${OPTION_ID}\n`, OPTION_ID.replace(/-/g, ''), 'g'.repeat(36), 7, null, [OPTION_ID], {}])(
    'rejects %j',
    (bad) => {
      expect(verdict({ optionId: bad })).toBe('A valid option id is required');
      expect(isAddonOptionId(bad)).toBe(false);
    },
  );
});

describe('role: one of ADDON_ROLES', () => {
  it.each([...ADDON_ROLES])('accepts "%s"', (role) => {
    expect(accepted({ role }).role).toBe(role);
  });

  it.each(['', 'Flavour', 'FLAVOUR', ' flavour', 'sauce', 'syrup', 'constructor', '__proto__', 'toString', 1, null, true, ['flavour'], {}])(
    'rejects %j',
    (bad) => {
      expect(verdict({ role: bad })).toBe('Invalid value for "role"');
    },
  );
});

describe('flavour_families: at most two distinct FLAVOUR_FAMILIES, in FLAVOUR_FAMILIES order', () => {
  it('accepts none', () => {
    expect(accepted({ flavour_families: [] }).flavour_families).toEqual([]);
  });

  it.each([...FLAVOUR_FAMILIES])('accepts "%s" alone', (family) => {
    expect(accepted({ flavour_families: [family] }).flavour_families).toEqual([family]);
  });

  it('accepts every pair of distinct families', () => {
    for (const a of FLAVOUR_FAMILIES) {
      for (const b of FLAVOUR_FAMILIES) {
        if (a === b) continue;
        expect(typeof verdict({ flavour_families: [a, b] }), `${a}+${b}`).not.toBe('string');
      }
    }
  });

  it('rejects a third family (the boundary is exactly two)', () => {
    expect(verdict({ flavour_families: ['nutty', 'caramel', 'fruity'] })).toBe('Invalid value for "flavour_families"');
    expect(verdict({ flavour_families: [...FLAVOUR_FAMILIES] })).toBe('Invalid value for "flavour_families"');
  });

  it('rejects a duplicate rather than merging it', () => {
    expect(verdict({ flavour_families: ['nutty', 'nutty'] })).toBe('Invalid value for "flavour_families"');
    expect(verdict({ flavour_families: ['nutty', 'nutty', 'caramel'] })).toBe('Invalid value for "flavour_families"');
  });

  it('rejects a word outside the vocabulary, a wrong case, or the wrong type', () => {
    for (const bad of [['savoury'], ['vanilla'], ['Nutty'], [' nutty'], ['nutty', 'bogus'], [1], [null], [['nutty']], 'nutty', null, 3, { 0: 'nutty' }]) {
      expect(verdict({ flavour_families: bad }), JSON.stringify(bad)).toBe('Invalid value for "flavour_families"');
    }
  });

  it('outputs the families in FLAVOUR_FAMILIES order, whatever order they came in', () => {
    // FLAVOUR_FAMILIES: chocolatey, caramel, nutty, biscuit, fruity, spiced, floral
    expect(accepted({ flavour_families: ['nutty', 'chocolatey'] }).flavour_families).toEqual(['chocolatey', 'nutty']);
    expect(accepted({ flavour_families: ['floral', 'caramel'] }).flavour_families).toEqual(['caramel', 'floral']);
    expect(accepted({ flavour_families: ['spiced', 'biscuit'] }).flavour_families).toEqual(['biscuit', 'spiced']);
    for (const a of FLAVOUR_FAMILIES) {
      for (const b of FLAVOUR_FAMILIES) {
        if (a === b) continue;
        const out = accepted({ flavour_families: [a, b] }).flavour_families;
        expect(out, `${a}+${b}`).toEqual(FLAVOUR_FAMILIES.filter((f) => f === a || f === b));
      }
    }
  });
});

describe('sweetness_delta: an integer 0–5', () => {
  it.each([0, 1, 2, 3, 4, 5])('accepts %i', (n) => {
    expect(accepted({ sweetness_delta: n }).sweetness_delta).toBe(n);
  });

  it.each([-1, 6, 10, 100, 0.5, 2.5, 4.999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '2', '', null, true, [], [2], {}])(
    'rejects %j',
    (bad) => {
      expect(verdict({ sweetness_delta: bad })).toBe('Invalid value for "sweetness_delta"');
    },
  );
});

describe.each([
  ['intensity_delta', ADDON_INTENSITY_DELTA_MAX],
  ['indulgence_delta', ADDON_INDULGENCE_DELTA_MAX],
] as const)('%s: an integer 0–2', (field, max) => {
  it('has a maximum of two', () => {
    expect(max).toBe(2);
  });

  it.each([0, 1, 2])('accepts %i', (n) => {
    expect(accepted({ [field]: n })[field]).toBe(n);
  });

  it.each([-1, 3, 5, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, false, [1]])('rejects %j', (bad) => {
    expect(verdict({ [field]: bad })).toBe(`Invalid value for "${field}"`);
  });
});

describe('negative zero', () => {
  it('is stored as a plain 0 (JSON can carry -0)', () => {
    const parsed = JSON.parse(JSON.stringify(VALID).replace('"sweetness_delta":2', '"sweetness_delta":-0'));
    expect(Object.is(parsed.sweetness_delta, -0)).toBe(true);
    const result = validateAddonTraitsPatch(parsed);
    if (typeof result === 'string') throw new Error(result);
    expect(Object.is(result.traits.sweetness_delta, 0)).toBe(true);
  });
});

describe('textures: at most two distinct TEXTURES', () => {
  it('accepts none', () => {
    expect(accepted({ textures: [] }).textures).toEqual([]);
  });

  it.each([...TEXTURES])('accepts "%s" alone', (texture) => {
    expect(accepted({ textures: [texture] }).textures).toEqual([texture]);
  });

  it('accepts every pair of distinct textures', () => {
    for (const a of TEXTURES) {
      for (const b of TEXTURES) {
        if (a === b) continue;
        expect(typeof verdict({ textures: [a, b] }), `${a}+${b}`).not.toBe('string');
      }
    }
  });

  it('rejects a third texture (the boundary is exactly two)', () => {
    expect(verdict({ textures: ['silky', 'creamy', 'frothy'] })).toBe('Invalid value for "textures"');
    expect(verdict({ textures: [...TEXTURES] })).toBe('Invalid value for "textures"');
  });

  it('rejects a duplicate rather than merging it', () => {
    expect(verdict({ textures: ['icy', 'icy'] })).toBe('Invalid value for "textures"');
    expect(verdict({ textures: ['silky', 'creamy', 'silky'] })).toBe('Invalid value for "textures"');
  });

  it('rejects a word outside the vocabulary, a wrong case, or the wrong type', () => {
    for (const bad of [['gritty'], ['Silky'], [' silky'], ['silky', 'bogus'], [1], [null], [['silky']], 'silky', null, 3, { 0: 'silky' }]) {
      expect(verdict({ textures: bad }), JSON.stringify(bad)).toBe('Invalid value for "textures"');
    }
  });

  it('keeps the order it was given (as the trait editor does)', () => {
    expect(accepted({ textures: ['crunchy', 'soft'] }).textures).toEqual(['crunchy', 'soft']);
    expect(accepted({ textures: ['soft', 'crunchy'] }).textures).toEqual(['soft', 'crunchy']);
  });

  it('refuses an oversized list without trouble', () => {
    expect(verdict({ textures: Array.from({ length: 100_000 }, () => 'icy') })).toBe('Invalid value for "textures"');
  });
});

describe('the first problem is the one reported, in field order', () => {
  it('role before families before the deltas before textures', () => {
    const allBad = { role: 'x', flavour_families: ['x'], sweetness_delta: 99, intensity_delta: 99, indulgence_delta: 99, textures: ['x'] };
    expect(verdict(allBad)).toBe('Invalid value for "role"');
    expect(verdict({ ...allBad, role: 'other' })).toBe('Invalid value for "flavour_families"');
    expect(verdict({ ...allBad, role: 'other', flavour_families: [] })).toBe('Invalid value for "sweetness_delta"');
    expect(verdict({ ...allBad, role: 'other', flavour_families: [], sweetness_delta: 0 })).toBe('Invalid value for "intensity_delta"');
    expect(verdict({ ...allBad, role: 'other', flavour_families: [], sweetness_delta: 0, intensity_delta: 0 })).toBe('Invalid value for "indulgence_delta"');
    expect(verdict({ ...allBad, role: 'other', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0 })).toBe('Invalid value for "textures"');
  });

  it('every message is plain text with no stack, path or SQL in it', () => {
    const messages = [
      verdict({ role: 'x' }),
      verdict({ flavour_families: ['x'] }),
      verdict({ sweetness_delta: 9 }),
      verdict({ textures: ['x'] }),
      verdict({ extra: 1 }),
      verdict({ optionId: 'x' }),
      verdict({ role: undefined }),
      validateAddonTraitsPatch(null),
    ] as string[];
    for (const m of messages) {
      expect(typeof m).toBe('string');
      expect(m).not.toMatch(/\bat \w+.*\(|\.ts\b|constraint|violates|select |insert /i);
    }
  });
});

describe('agreement with supabase/2026-10-coffey-addons-pairings.sql', () => {
  it('the role check lists exactly ADDON_ROLES — and so does the validator', () => {
    expect(quoted(constraintStatement('addon_option_traits_role_check'))).toEqual([...ADDON_ROLES]);
    for (const role of quoted(constraintStatement('addon_option_traits_role_check'))) expect(accepted({ role }).role).toBe(role);
  });

  it('the families check lists exactly FLAVOUR_FAMILIES and caps them at ADDON_FAMILIES_MAX', () => {
    expect(quoted(constraintStatement('addon_option_traits_flavour_families_check'))).toEqual([...FLAVOUR_FAMILIES]);
    expect(cardinalityCap('flavour_families')).toBe(ADDON_FAMILIES_MAX);
  });

  it('the textures check lists exactly TEXTURES and caps them at ADDON_TEXTURES_MAX', () => {
    expect(quoted(constraintStatement('addon_option_traits_textures_check'))).toEqual([...TEXTURES]);
    expect(cardinalityCap('textures')).toBe(ADDON_TEXTURES_MAX);
  });

  it('the three delta checks have the bounds the validator enforces', () => {
    expect(betweenBounds('sweetness_delta')).toEqual([0, ADDON_SWEETNESS_DELTA_MAX]);
    expect(betweenBounds('intensity_delta')).toEqual([0, ADDON_INTENSITY_DELTA_MAX]);
    expect(betweenBounds('indulgence_delta')).toEqual([0, ADDON_INDULGENCE_DELTA_MAX]);
  });

  it('sweeping each delta around the SQL bounds, the validator accepts exactly what the CHECK accepts', () => {
    for (const field of ['sweetness_delta', 'intensity_delta', 'indulgence_delta'] as const) {
      const [min, max] = betweenBounds(field);
      for (let n = min - 3; n <= max + 3; n += 1) {
        const dbAccepts = n >= min && n <= max;
        expect(typeof verdict({ [field]: n }) !== 'string', `${field}=${n}`).toBe(dbAccepts);
      }
    }
  });

  it('sweeping list sizes around the SQL caps, the validator accepts exactly what the CHECK accepts (for distinct members)', () => {
    const familyCap = cardinalityCap('flavour_families');
    const textureCap = cardinalityCap('textures');
    for (let size = 0; size <= familyCap + 2; size += 1) {
      expect(typeof verdict({ flavour_families: FLAVOUR_FAMILIES.slice(0, size) }) !== 'string', `${size} families`).toBe(size <= familyCap);
    }
    for (let size = 0; size <= textureCap + 2; size += 1) {
      expect(typeof verdict({ textures: TEXTURES.slice(0, size) }) !== 'string', `${size} textures`).toBe(size <= textureCap);
    }
  });

  it('a value the CHECK would reject is never accepted: out-of-vocabulary roles, families and textures', () => {
    const roles = new Set(quoted(constraintStatement('addon_option_traits_role_check')));
    for (const role of ['bogus', 'Flavour', 'syrup']) expect(roles.has(role) || typeof verdict({ role }) !== 'string').toBe(roles.has(role));
    expect(typeof verdict({ flavour_families: ['bogus'] })).toBe('string');
    expect(typeof verdict({ textures: ['bogus'] })).toBe('string');
  });
});

describe('agreement with the derived defaults', () => {
  interface SnapshotAddonOption {
    group: string;
    group_label: string;
    option: string;
  }
  const snapshot: { addon_options: SnapshotAddonOption[] } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data/inventory/menu-snapshot.json'), 'utf8'),
  );

  it('the snapshot has options to check', () => {
    expect(snapshot.addon_options.length).toBeGreaterThan(50);
  });

  it('every option on the live menu can be saved exactly as derived — the owner can pin a default without it being refused', () => {
    for (const o of snapshot.addon_options) {
      const derived = deriveAddonTraits({ name: o.group, display_name: o.group_label }, { name: o.option });
      const result = validateAddonTraitsPatch({ optionId: OPTION_ID, ...derived });
      expect(typeof result, `${o.group} | ${o.option}`).not.toBe('string');
      if (typeof result !== 'string') expect(result.traits, `${o.group} | ${o.option}`).toEqual(derived);
    }
  });
});
