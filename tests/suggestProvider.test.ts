import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Phase 7 — lib/suggest/models.ts provider selection (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §1, §5.6). Pure: no network, no 'server-only'.

import {
  costUsdMicros,
  deciderModelLabel,
  deciderProvider,
  geminiModel,
  geminiWorkerModel,
  jevModel,
  llmDisabledReason,
  llmEnabled,
  llmProvider,
  textProvider,
  workerModelLabel,
} from '@/lib/suggest/models';

const ENV_KEYS = [
  'SUGGEST_LLM',
  'SUGGEST_LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_WORKER_MODEL',
  'TYPESAFE_API_KEY',
  'JEV_MODEL',
] as const;
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

describe('llmProvider() — auto (no SUGGEST_LLM_PROVIDER pin)', () => {
  it('is null when neither key is set', () => {
    expect(llmProvider()).toBeNull();
    expect(llmEnabled()).toBe(false);
  });

  it('is "anthropic" when only ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(llmProvider()).toBe('anthropic');
    expect(llmEnabled()).toBe(true);
  });

  it('is "gemini" when only GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('gemini');
    expect(llmEnabled()).toBe(true);
  });

  it('prefers "anthropic" when both keys are set (unchanged default behaviour)', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('anthropic');
  });
});

describe('llmProvider() — explicit SUGGEST_LLM_PROVIDER pin', () => {
  it('pins "gemini" only when GEMINI_API_KEY is set, even with an Anthropic key present', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('gemini');
  });

  it('pinning "gemini" with GEMINI_API_KEY unset is null — never silently falls back to Anthropic', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(llmProvider()).toBeNull();
  });

  it('pins "anthropic" only when ANTHROPIC_API_KEY is set, even with a Gemini key present', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('anthropic');
  });

  it('pinning "anthropic" with ANTHROPIC_API_KEY unset is null', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'anthropic';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBeNull();
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    process.env.SUGGEST_LLM_PROVIDER = '  GEMINI  ';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('gemini');
  });

  it('an unrecognised pin value falls back to auto selection', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'bogus';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('gemini');
  });
});

describe('llmProvider() — SUGGEST_LLM kill switch', () => {
  for (const off of ['off', 'false', '0', 'OFF', ' off ']) {
    it(`SUGGEST_LLM=${JSON.stringify(off)} is null regardless of keys`, () => {
      process.env.SUGGEST_LLM = off;
      process.env.ANTHROPIC_API_KEY = 'ak-1';
      process.env.GEMINI_API_KEY = 'gk-1';
      expect(llmProvider()).toBeNull();
      expect(llmEnabled()).toBe(false);
    });
  }

  it('SUGGEST_LLM=on (or unset) does not itself disable anything', () => {
    process.env.SUGGEST_LLM = 'on';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmProvider()).toBe('gemini');
  });
});

describe('llmDisabledReason()', () => {
  it('is null when a provider is active', () => {
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(llmDisabledReason()).toBeNull();
  });

  it('is "disabled" when the kill switch is off, whatever the keys', () => {
    process.env.SUGGEST_LLM = 'off';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(llmDisabledReason()).toBe('disabled');
  });

  it('is "no_key" when no usable provider key is configured', () => {
    expect(llmDisabledReason()).toBe('no_key');
  });

  it('is "no_key" when a pin names a provider whose key is missing (not "disabled")', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'ak-1'; // present, but the pin ignores it
    expect(llmDisabledReason()).toBe('no_key');
  });
});

describe('geminiModel() / geminiWorkerModel()', () => {
  it('defaults to gemini-3-flash-preview', () => {
    expect(geminiModel()).toBe('gemini-3-flash-preview');
    expect(geminiWorkerModel()).toBe('gemini-3-flash-preview');
  });

  it('GEMINI_MODEL overrides the default (trimmed)', () => {
    process.env.GEMINI_MODEL = '  gemini-custom-id  ';
    expect(geminiModel()).toBe('gemini-custom-id');
  });

  it('geminiWorkerModel() falls back to geminiModel() when GEMINI_WORKER_MODEL is unset', () => {
    process.env.GEMINI_MODEL = 'gemini-main';
    expect(geminiWorkerModel()).toBe('gemini-main');
  });

  it('GEMINI_WORKER_MODEL overrides independently', () => {
    process.env.GEMINI_MODEL = 'gemini-main';
    process.env.GEMINI_WORKER_MODEL = 'gemini-worker';
    expect(geminiWorkerModel()).toBe('gemini-worker');
  });
});

describe('deciderModelLabel() / workerModelLabel()', () => {
  it('is the raw Anthropic id when Anthropic is the active provider', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(deciderModelLabel()).toBe('claude-opus-5');
    expect(workerModelLabel()).toBe('claude-sonnet-5');
  });

  it('is "gemini:<model>" when Gemini is the active provider', () => {
    process.env.GEMINI_API_KEY = 'gk-1';
    process.env.GEMINI_MODEL = 'gemini-3-flash-preview';
    expect(deciderModelLabel()).toBe('gemini:gemini-3-flash-preview');
    expect(workerModelLabel()).toBe('gemini:gemini-3-flash-preview');
  });
});

describe('costUsdMicros()', () => {
  it('is 0 for a raw Gemini model id', () => {
    expect(costUsdMicros('gemini-3-flash-preview', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 })).toBe(0);
  });

  it('is 0 for the "gemini:<model>" label form too', () => {
    expect(costUsdMicros('gemini:gemini-3-flash-preview', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 })).toBe(0);
  });

  it('still prices Anthropic models normally (unchanged behaviour)', () => {
    const micros = costUsdMicros('claude-opus-5', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    expect(micros).toBe(5_000_000); // $5 per MTok input
  });

  it('is round(inputTokens x 0.042) for a raw Jev model id, with output free', () => {
    const micros = costUsdMicros('jev-latest', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 });
    expect(micros).toBe(42_000); // $0.042 per MTok input, output free
  });

  it('is round(inputTokens x 0.042) for the "jev:<model>" label form too', () => {
    const micros = costUsdMicros('jev:jev-latest', { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 });
    expect(micros).toBe(Math.round(500 * 0.042));
  });

  it('rounds to the nearest integer micro-dollar for Jev', () => {
    expect(costUsdMicros('jev-latest', { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(0); // round(0.42) = 0
    expect(costUsdMicros('jev-latest', { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(4); // round(4.2) = 4
  });
});

describe('jevModel()', () => {
  it('defaults to jev-latest', () => {
    expect(jevModel()).toBe('jev-latest');
  });

  it('JEV_MODEL overrides the default (trimmed)', () => {
    process.env.JEV_MODEL = '  jev-custom-id  ';
    expect(jevModel()).toBe('jev-custom-id');
  });
});

describe('deciderProvider() — auto (no pin)', () => {
  it('is null when no key is set', () => {
    expect(deciderProvider()).toBeNull();
  });

  it('is "jev" when only TYPESAFE_API_KEY is set', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(deciderProvider()).toBe('jev');
  });

  it('prefers "jev" over "anthropic" and "gemini" when all three keys are set', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBe('jev');
  });

  it('falls back to "anthropic" when TYPESAFE_API_KEY is unset but ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBe('anthropic');
  });

  it('falls back to "gemini" when only GEMINI_API_KEY is set', () => {
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBe('gemini');
  });
});

describe('deciderProvider() — explicit SUGGEST_LLM_PROVIDER pin', () => {
  it('pins "jev" only when TYPESAFE_API_KEY is set, even with the other keys present', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBe('jev');
  });

  it('pinning "jev" with TYPESAFE_API_KEY unset is null — never silently falls back to another provider', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'jev';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(deciderProvider()).toBeNull();
  });

  it('is case-insensitive for "jev" too', () => {
    process.env.SUGGEST_LLM_PROVIDER = '  JEV  ';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(deciderProvider()).toBe('jev');
  });
});

describe('deciderProvider() — SUGGEST_LLM kill switch disables Jev too', () => {
  it('SUGGEST_LLM=off is null even with TYPESAFE_API_KEY set', () => {
    process.env.SUGGEST_LLM = 'off';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(deciderProvider()).toBeNull();
  });
});

describe('llmProvider()/llmEnabled()/llmDisabledReason() — alias deciderProvider() (incl. Jev)', () => {
  it('llmProvider() returns "jev" exactly like deciderProvider()', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(llmProvider()).toBe('jev');
    expect(llmEnabled()).toBe(true);
    expect(llmDisabledReason()).toBeNull();
  });
});

describe('textProvider() — never returns "jev" (digest needs prose)', () => {
  it('is null when no key is set', () => {
    expect(textProvider()).toBeNull();
  });

  it('is "anthropic" when only ANTHROPIC_API_KEY is set, Jev key notwithstanding', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(textProvider()).toBe('anthropic');
  });

  it('is "gemini" when only GEMINI_API_KEY is set, Jev key notwithstanding', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(textProvider()).toBe('gemini');
  });

  it('is null when ONLY TYPESAFE_API_KEY is set — Jev can never answer a text job', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(textProvider()).toBeNull();
  });

  it('a SUGGEST_LLM_PROVIDER=jev pin falls through to auto selection for text (Anthropic preferred)', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(textProvider()).toBe('anthropic');
  });

  it('a SUGGEST_LLM_PROVIDER=jev pin with no Anthropic/Gemini key falls through to null', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'jev';
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(textProvider()).toBeNull();
  });

  it('respects an explicit "anthropic"/"gemini" pin exactly like deciderProvider() does', () => {
    process.env.SUGGEST_LLM_PROVIDER = 'gemini';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(textProvider()).toBe('gemini');
  });

  it('SUGGEST_LLM=off disables text generation too', () => {
    process.env.SUGGEST_LLM = 'off';
    process.env.ANTHROPIC_API_KEY = 'ak-1';
    expect(textProvider()).toBeNull();
  });
});

describe('deciderModelLabel() — Jev', () => {
  it('is "jev:<model>" when Jev is the active decider provider', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.JEV_MODEL = 'jev-custom';
    expect(deciderModelLabel()).toBe('jev:jev-custom');
  });
});

describe('workerModelLabel() — Jev is never the digest worker', () => {
  it('falls back to Anthropic\'s raw model id when only TYPESAFE_API_KEY is set (textProvider() is null)', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    expect(workerModelLabel()).toBe('claude-sonnet-5');
  });

  it('still returns "gemini:<model>" when Gemini is configured, even with a Jev key also present', () => {
    process.env.TYPESAFE_API_KEY = 'tk-1';
    process.env.GEMINI_API_KEY = 'gk-1';
    expect(workerModelLabel()).toBe('gemini:gemini-3-flash-preview');
  });
});
