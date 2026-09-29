import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Phase 7 — lib/suggest/models.ts provider selection (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §1, §5.6). Jev is the only model. Pure: no network, no 'server-only'.

import {
  costUsdMicros,
  deciderModelLabel,
  deciderProvider,
  jevModel,
  llmDisabledReason,
  llmEnabled,
  llmProvider,
} from '@/lib/suggest/models';

const ENV_KEYS = ['SUGGEST_LLM', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'TYPESAFE_API_KEY', 'JEV_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('deciderProvider()', () => {
  it('is null when TYPESAFE_API_KEY is unset', () => {
    expect(deciderProvider()).toBeNull();
    expect(llmEnabled()).toBe(false);
  });

  it('is "jev" when TYPESAFE_API_KEY is set', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(deciderProvider()).toBe('jev');
    expect(llmEnabled()).toBe(true);
  });

  it('ignores ANTHROPIC_API_KEY / GEMINI_API_KEY — no other provider is ever selected', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBeNull();
  });

  it('llmProvider() is an alias for deciderProvider()', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(llmProvider()).toBe('jev');
  });
});

describe('deciderProvider() — SUGGEST_LLM kill switch', () => {
  for (const off of ['off', 'false', '0', 'OFF', ' off ']) {
    it(`SUGGEST_LLM=${JSON.stringify(off)} is null even with TYPESAFE_API_KEY set`, () => {
      process.env.SUGGEST_LLM = off;
      process.env.TYPESAFE_API_KEY = 'tk-1';
      expect(deciderProvider()).toBeNull();
      expect(llmEnabled()).toBe(false);
    });
  }

  it('SUGGEST_LLM=on (or unset) does not itself disable anything', () => {
    process.env.SUGGEST_LLM = 'on';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(deciderProvider()).toBe('jev');
  });
});

describe('llmDisabledReason()', () => {
  it('is null when Jev is active', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(llmDisabledReason()).toBeNull();
  });

  it('is "disabled" when the kill switch is off, whatever the keys', () => {
    process.env.SUGGEST_LLM = 'off';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(llmDisabledReason()).toBe('disabled');
  });

  it('is "no_key" when TYPESAFE_API_KEY is unset', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1'; // present, but no longer used
    expect(llmDisabledReason()).toBe('no_key');
  });
});

describe('jevModel() / deciderModelLabel()', () => {
  it('defaults to jev-latest', () => {
    expect(jevModel()).toBe('jev-latest');
    expect(deciderModelLabel()).toBe('jev:jev-latest');
  });

  it('JEV_MODEL overrides the default (trimmed)', () => {
    process.env.JEV_MODEL = '  jev-custom-id  ';
    expect(jevModel()).toBe('jev-custom-id');
    expect(deciderModelLabel()).toBe('jev:jev-custom-id');
  });
});

describe('costUsdMicros()', () => {
  it('is round(inputTokens x 0.042), with output free', () => {
    const micros = costUsdMicros('jev-latest', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 });
    expect(micros).toBe(42_000); // $0.042 per MTok input, output free
  });

  it('prices the "jev:<model>" label form the same way', () => {
    const micros = costUsdMicros('jev:jev-latest', { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 });
    expect(micros).toBe(Math.round(500 * 0.042));
  });

  it('rounds to the nearest integer micro-dollar', () => {
    expect(costUsdMicros('jev-latest', { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(0); // round(0.42) = 0
    expect(costUsdMicros('jev-latest', { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(4); // round(4.2) = 4
  });
});
