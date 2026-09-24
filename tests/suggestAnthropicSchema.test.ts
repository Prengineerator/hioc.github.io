import { describe, expect, it, vi } from 'vitest';

// llm.ts / traitsPrompt.ts construct nothing at import time, but they import
// SDK-backed modules; stub the clients so importing the schemas is inert.
vi.mock('@/lib/suggest/anthropic', () => ({ getAnthropicClient: () => null, SERVER_FALLBACK_BETA: 'x', SERVER_FALLBACKS: 'default' }));
vi.mock('@/lib/suggest/jev', () => ({ getJevClient: () => null }));

import { ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS, toAnthropicSchema } from '@/lib/suggest/schema';
import { ANTHROPIC_OUTPUT_SCHEMA as PICKS_SCHEMA, OUTPUT_SCHEMA as PICKS_SOURCE } from '@/lib/suggest/llm';
import { ANTHROPIC_OUTPUT_SCHEMA as TRAITS_SCHEMA, OUTPUT_SCHEMA as TRAITS_SOURCE } from '@/lib/suggest/traitsPrompt';

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('toAnthropicSchema', () => {
  it('removes numeric, string-length and array-size constraints at any depth', () => {
    const out = toAnthropicSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 0, maximum: 3 },
        s: { type: 'string', maxLength: 120 },
        a: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', properties: { x: { type: 'number', multipleOf: 2 } } } },
      },
    });
    const keys = keysDeep(out);
    for (const bad of ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS) expect(keys).not.toContain(bad);
  });

  it('restates the stripped rule in the description so the model still sees it', () => {
    const out = toAnthropicSchema({ type: 'integer', minimum: 0, maximum: 3, description: 'Sweetness' }) as { description: string };
    expect(out.description).toBe('Sweetness (between 0 and 3)');
    const arr = toAnthropicSchema({ type: 'array', maxItems: 5, items: { type: 'string' } }) as { description: string };
    expect(arr.description).toBe('(at most 5 items)');
  });

  it('keeps enum / required / const values untouched and does not mutate the source', () => {
    const src = { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['x', 'y'] } }, maxProperties: 3 } as const;
    const out = toAnthropicSchema(src) as { required: string[]; properties: { a: { enum: string[] } } };
    expect(out.required).toEqual(['a']);
    expect(out.properties.a.enum).toEqual(['x', 'y']);
    expect(src).toHaveProperty('required');
  });
});

describe('the schemas actually sent to Anthropic', () => {
  it.each([
    ['picks', PICKS_SCHEMA],
    ['trait tagging', TRAITS_SCHEMA],
  ])('%s schema contains no keyword Anthropic rejects', (_name, schema) => {
    const keys = keysDeep(schema);
    for (const bad of ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS) expect(keys).not.toContain(bad);
  });

  it('leaves the shared (Gemini) schemas with their constraints', () => {
    expect(keysDeep(TRAITS_SOURCE)).toContain('maximum');
    expect(keysDeep(PICKS_SOURCE)).toContain('maxItems');
  });
});
