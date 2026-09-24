// Anthropic structured outputs accept only a subset of JSON Schema: numeric
// constraints (minimum/maximum/multipleOf), string length limits and array
// size limits are rejected with a 400 ("For 'integer' type, properties
// maximum, minimum are not supported"). Gemini accepts them, so the shared
// schemas keep them and ONLY the copy sent to Anthropic is stripped here.
//
// Nothing is lost: every stripped rule is (a) restated in the field's
// description so the model still sees it, and (b) enforced after the reply
// by our own validators (traitsValidate.ts, validate.ts) — model output is
// data, never trusted as-is (playbook S-2).
//
// Pure: no SDK import, unit-testable.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const UNSUPPORTED = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

function hintFor(node: { [key: string]: Json }): string | null {
  const parts: string[] = [];
  const { minimum, maximum, minItems, maxItems, minLength, maxLength } = node;
  if (typeof minimum === 'number' && typeof maximum === 'number') parts.push(`between ${minimum} and ${maximum}`);
  else if (typeof minimum === 'number') parts.push(`at least ${minimum}`);
  else if (typeof maximum === 'number') parts.push(`at most ${maximum}`);
  if (typeof minItems === 'number' && typeof maxItems === 'number') parts.push(`${minItems} to ${maxItems} items`);
  else if (typeof maxItems === 'number') parts.push(`at most ${maxItems} items`);
  else if (typeof minItems === 'number' && minItems > 0) parts.push(`at least ${minItems} item${minItems === 1 ? '' : 's'}`);
  if (typeof maxLength === 'number') parts.push(`at most ${maxLength} characters`);
  else if (typeof minLength === 'number' && minLength > 0) parts.push(`at least ${minLength} characters`);
  return parts.length ? parts.join(', ') : null;
}

function strip(value: Json): Json {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;
  const hint = hintFor(value);
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if ((UNSUPPORTED as readonly string[]).includes(key)) continue;
    // `properties` maps names to schemas; `enum` / `required` are data, not schemas.
    out[key] = key === 'enum' || key === 'required' || key === 'const' ? child : strip(child);
  }
  if (hint) {
    const existing = typeof out.description === 'string' ? out.description.trim() : '';
    out.description = existing ? `${existing} (${hint})` : `(${hint})`;
  }
  return out;
}

/** A deep copy of `schema` safe to send as Anthropic `output_config.format.schema`. */
export function toAnthropicSchema<T>(schema: T): { [key: string]: unknown } {
  return strip(JSON.parse(JSON.stringify(schema)) as Json) as { [key: string]: unknown };
}

/** The keywords Anthropic structured outputs reject (exported for tests). */
export const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS: readonly string[] = UNSUPPORTED;
