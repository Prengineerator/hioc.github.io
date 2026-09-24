import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Phase 7 — lib/suggest/models.ts provider selection (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §1, §5.6). Pure: no network, no 'server-only'.

import {
  costUsdMicros,
  deciderModelLabel,
  geminiModel,
  geminiWorkerModel,
  llmDisabledReason,
  llmEnabled,
  llmProvider,
  workerModelLabel,
} from '@/lib/suggest/models';

const ENV_KEYS = ['SUGGEST_LLM', 'SUGGEST_LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_WORKER_MODEL'] as const;
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
  it('defaults to gemini-3-flash', () => {
    expect(geminiModel()).toBe('gemini-3-flash');
    expect(geminiWorkerModel()).toBe('gemini-3-flash');
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
    process.env.GEMINI_MODEL = 'gemini-3-flash';
    expect(deciderModelLabel()).toBe('gemini:gemini-3-flash');
    expect(workerModelLabel()).toBe('gemini:gemini-3-flash');
  });
});

describe('costUsdMicros()', () => {
  it('is 0 for a raw Gemini model id', () => {
    expect(costUsdMicros('gemini-3-flash', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 })).toBe(0);
  });

  it('is 0 for the "gemini:<model>" label form too', () => {
    expect(costUsdMicros('gemini:gemini-3-flash', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 })).toBe(0);
  });

  it('still prices Anthropic models normally (unchanged behaviour)', () => {
    const micros = costUsdMicros('claude-opus-5', { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    expect(micros).toBe(5_000_000); // $5 per MTok input
  });
});
