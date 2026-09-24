import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-4 — lib/suggest/llm.ts's Opus decider: catalog serialization
// (§5.4 "What Opus sees") and the STABLE_SYSTEM_PROMPT guidance this ticket
// adds. The Anthropic client is mocked at the module boundary (same pattern
// as tests/suggestAnthropicSchema.test.ts) — no network, no real key.

const createMock = vi.fn();

vi.mock('@/lib/suggest/anthropic', () => ({
  getAnthropicClient: () => ({ beta: { messages: { create: createMock } } }),
  SERVER_FALLBACK_BETA: 'server-side-fallback-2026-07-01',
  SERVER_FALLBACKS: 'default',
}));
vi.mock('@/lib/suggest/jev', () => ({ getJevClient: () => null }));

import { opusDecider } from '@/lib/suggest/llm';
import type { Candidate, ProfileSummary, SuggestInputs } from '@/lib/suggest/types';

function candidate(over: Partial<Candidate> & { menuItemId: string }): Candidate {
  return {
    name: 'Test Item',
    score: 0.8,
    minPriceInr: 100,
    maxPriceInr: 100,
    category: 'Coffee',
    description: 'A rich, bold coffee with a long, clean finish that regulars keep coming back for.',
    traits: {
      menu_item_id: over.menuItemId,
      temperature: 'hot',
      caffeine: 'high',
      is_coffee: true,
      sweetness: 0,
      body: 'light',
      kind: 'drink',
      moods: ['boost'],
      dayparts: ['morning'],
      flavor_notes: ['bold', 'nutty'],
      source: 'opus',
      confirmed: true,
      updated_at: '2026-01-01T00:00:00Z',
    },
    ...over,
  };
}

const BASE_INPUTS: SuggestInputs = {
  temperature: 'either',
  base: 'either',
  extras: [],
  needs: [],
  budget: 'any',
  mood: 'boost',
  note: '',
};

function mockGoodResponse(picks: { menu_item_id: string; reason: string; reason_code: string }[] = []) {
  createMock.mockResolvedValueOnce({
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: 'text', text: JSON.stringify({ header: 'Here you go', picks }) }],
  });
}

async function callAndCapture(shortlist: Candidate[], profile: ProfileSummary | null = null, inputs = BASE_INPUTS) {
  mockGoodResponse();
  await opusDecider({ inputs, shortlist, profile, daypart: 'morning', signal: new AbortController().signal });
  expect(createMock).toHaveBeenCalledTimes(1);
  return createMock.mock.calls[0][0] as {
    system: { text: string }[];
    messages: { content: { text: string }[] }[];
  };
}

describe('opusDecider — catalog serialization (§5.4, root cause #3: "Opus sees too little")', () => {
  beforeEach(() => createMock.mockReset());

  it("sends each candidate's description (trimmed to 160 chars) and flavor_notes, sorted by id", async () => {
    const longDescription = 'x'.repeat(220);
    const shortlist: Candidate[] = [
      candidate({ menuItemId: 'zzz-item', description: 'Short desc.' }),
      candidate({ menuItemId: 'aaa-item', description: longDescription }),
    ];
    const call = await callAndCapture(shortlist);

    const catalogText = call.messages[0].content[0].text;
    expect(catalogText.startsWith('CANDIDATES (choose only from these, by id):\n')).toBe(true);
    const parsed = JSON.parse(catalogText.replace(/^CANDIDATES \(choose only from these, by id\):\n/, '')) as {
      candidates: { id: string; description: string; traits: { flavor_notes: string[] } }[];
    };

    // Sorted by id — the cached-prefix byte-stability rule (§5.4).
    expect(parsed.candidates.map((c) => c.id)).toEqual(['aaa-item', 'zzz-item']);

    const aaa = parsed.candidates.find((c) => c.id === 'aaa-item')!;
    expect(aaa.description.length).toBe(160);
    expect(aaa.traits.flavor_notes).toEqual(['bold', 'nutty']);

    const zzz = parsed.candidates.find((c) => c.id === 'zzz-item')!;
    expect(zzz.description).toBe('Short desc.');
  });

  it('trims a description with leading/trailing whitespace before capping it', async () => {
    const shortlist: Candidate[] = [candidate({ menuItemId: 'espresso', description: '   padded description   ' })];
    const call = await callAndCapture(shortlist);
    const catalogText = call.messages[0].content[0].text;
    const parsed = JSON.parse(catalogText.replace(/^CANDIDATES \(choose only from these, by id\):\n/, '')) as {
      candidates: { description: string }[];
    };
    expect(parsed.candidates[0].description).toBe('padded description');
  });

  it('never includes a name/phone/email/order/customer key anywhere sent to the model (S-3)', async () => {
    const shortlist: Candidate[] = [candidate({ menuItemId: 'espresso' })];
    const profile: ProfileSummary = {
      topCategories: ['Coffee'],
      icedLean: 'hot',
      sweetLean: 'low',
      priceComfort: 'mid',
      orderingMood: 'routine',
      usualItemIds: ['espresso'],
    };
    const call = await callAndCapture(shortlist, profile);
    const serialized = JSON.stringify(call).toLowerCase();
    for (const forbidden of ['"name"', 'phone', 'email', 'order_id', 'order id', 'customer_id', 'session_id']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('STABLE_SYSTEM_PROMPT — decision-prompt guidance this ticket adds (§4 tone rules kept intact)', () => {
  beforeEach(() => createMock.mockReset());

  it('honours explicit choices first, gives per-mood guidance, names chocolatey/fruity, asks for specific reasons and a mood-reflecting header', async () => {
    const shortlist: Candidate[] = [candidate({ menuItemId: 'espresso' })];
    const call = await callAndCapture(shortlist);
    const systemText = call.system[0].text;

    expect(systemText).toMatch(/explicit choices first/i);
    expect(systemText).toMatch(/boost/i);
    expect(systemText).toMatch(/cosy/i);
    expect(systemText).toMatch(/celebrate/i);
    expect(systemText).toMatch(/comfort/i);
    expect(systemText).toMatch(/surprise/i);
    expect(systemText).toMatch(/chocolatey/i);
    expect(systemText).toMatch(/fruity/i);
    expect(systemText).toMatch(/specific/i);
    expect(systemText).toMatch(/variety/i);
    expect(systemText).toMatch(/header.*mood/i);

    // §4 "Never" rules still present, verbatim in spirit.
    expect(systemText).toMatch(/spending/i);
    expect(systemText).toMatch(/hurry/i);
    expect(systemText).toMatch(/healthy/i);
    expect(systemText).toMatch(/at most one emoji/i);
    expect(systemText).toMatch(/at most 120 characters/i);
  });
});
