import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 — lib/suggest/gemini.ts: raw REST transport for the free-tier
// provider (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.4, §5.6, §9 S-6).
// `fetch` is mocked at the global level — no network, no real key.

import { geminiGenerateJson, geminiGenerateText } from '@/lib/suggest/gemini';

const API_KEY = 'gk-test-secret-should-never-leak-anywhere';
const URL_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/models/';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.GEMINI_API_KEY = API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } as const;

function baseArgs(overrides: Partial<Parameters<typeof geminiGenerateJson>[0]> = {}) {
  return {
    model: 'gemini-3-flash-preview',
    system: 'system prompt text',
    user: 'user message text',
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 500,
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('geminiGenerateJson — request shape', () => {
  it('POSTs to the model URL, sends the key only as a header (never in the URL), and never sends temperature/thinking config', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 0 },
      }),
    );

    await geminiGenerateJson(baseArgs());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

    expect(url).toBe(`${URL_PREFIX}gemini-3-flash-preview:generateContent`);
    expect(url).not.toContain(API_KEY);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-goog-api-key']).toBe(API_KEY);

    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'system prompt text' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'user message text' }] }]);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual(SCHEMA);
    expect(body.generationConfig.maxOutputTokens).toBe(500);
    expect(body.generationConfig.temperature).toBeUndefined();
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.thinkingConfig).toBeUndefined();
  });

  it('skips parts where thought === true when concatenating text', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: 'thinking out loud...', thought: true }, { text: '{"ok":' }, { text: 'true}' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, cachedContentTokenCount: 3 },
      }),
    );

    const { json, usage } = await geminiGenerateJson(baseArgs());
    expect(json).toEqual({ ok: true });
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
  });

  it('maps usageMetadata fields, defaulting to 0 when usageMetadata is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }),
    );
    const { usage } = await geminiGenerateJson(baseArgs());
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  });
});

describe('geminiGenerateJson — error kinds', () => {
  it('abort/timeout → DeciderError kind "timeout"', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(geminiGenerateJson(baseArgs({ timeoutMs: 20 }))).rejects.toMatchObject({ name: 'DeciderError', kind: 'timeout' });
  });

  it('promptFeedback.blockReason → "refusal"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('finishReason SAFETY/PROHIBITED_CONTENT/BLOCKLIST/RECITATION → "refusal"', async () => {
    for (const finishReason of ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'RECITATION']) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason }] }));
      await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'refusal' });
    }
  });

  it('finishReason MAX_TOKENS → "invalid_output"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"ok"' }] }, finishReason: 'MAX_TOKENS' }] }),
    );
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('no text content → "invalid_output"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }));
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('unparsable JSON text → "invalid_output"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'not json at all' }] }, finishReason: 'STOP' }] }),
    );
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('HTTP 500 → "error" with the status in the message, and the key never appears in it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: { message: 'internal server hiccup' } }));
    let caught: unknown;
    try {
      await geminiGenerateJson(baseArgs());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ kind: 'error' });
    const message = (caught as Error).message;
    expect(message).toContain('500');
    expect(message).toContain('internal server hiccup');
    expect(message).not.toContain(API_KEY);
  });

  it('GEMINI_API_KEY unset → "error", no fetch call, no key to leak', async () => {
    delete process.env.GEMINI_API_KEY;
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('geminiGenerateJson — schema robustness (one-shot retry)', () => {
  it('retries once without responseJsonSchema when the API 400s specifically on the schema field', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: { message: 'Invalid JSON payload received. Unknown name "responseJsonSchema" at generationConfig' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, cachedContentTokenCount: 0 },
        }),
      );

    const { json } = await geminiGenerateJson(baseArgs());
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    const secondBody = JSON.parse(secondInit.body as string);
    expect(secondBody.generationConfig.responseJsonSchema).toBeUndefined();
    expect(secondBody.generationConfig.responseMimeType).toBe('application/json');
    expect(secondBody.systemInstruction.parts[0].text).toContain('Respond with JSON matching this JSON Schema exactly:');
    expect(secondBody.systemInstruction.parts[0].text).toContain(JSON.stringify(SCHEMA));
  });

  it('does NOT retry a 400 that is unrelated to the schema', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: 'API key not valid' } }));
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a schema-related 400 on the RETRY itself as an "error" rather than looping', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad responseJsonSchema' } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'still bad' } }));
    await expect(geminiGenerateJson(baseArgs())).rejects.toMatchObject({ kind: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('geminiGenerateJson — thinkingLevel (speed-up for tagging/decision calls)', () => {
  it('sends generationConfig.thinkingConfig.thinkingLevel when thinkingLevel is set', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }),
    );
    await geminiGenerateJson(baseArgs({ thinkingLevel: 'low' }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  it('sends no thinkingConfig when thinkingLevel is omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }),
    );
    await geminiGenerateJson(baseArgs());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('a 400 mentioning "thinking" retries once WITHOUT thinkingConfig, keeping the schema', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'Unknown name "thinkingConfig" at generationConfig' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, cachedContentTokenCount: 0 },
        }),
      );

    const { json } = await geminiGenerateJson(baseArgs({ thinkingLevel: 'low' }));
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(secondBody.generationConfig.thinkingConfig).toBeUndefined();
    // The schema retry is a SEPARATE drop — a pure thinking-400 keeps the schema.
    expect(secondBody.generationConfig.responseJsonSchema).toEqual(SCHEMA);
  });

  it('both a schema-related AND a thinking-related 400 can each be dropped, capped at 3 HTTP attempts total', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad responseJsonSchema' } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'thinkingConfig not supported' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, cachedContentTokenCount: 0 },
        }),
      );

    const { json } = await geminiGenerateJson(baseArgs({ thinkingLevel: 'low' }));
    expect(json).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const thirdBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(thirdBody.generationConfig.responseJsonSchema).toBeUndefined();
    expect(thirdBody.generationConfig.thinkingConfig).toBeUndefined();
  });

  it('never makes more than 3 HTTP attempts for one logical call', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'bad responseJsonSchema' } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'thinkingConfig not supported' } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: 'still schema trouble' } }));

    await expect(geminiGenerateJson(baseArgs({ thinkingLevel: 'low' }))).rejects.toMatchObject({ kind: 'error' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('geminiGenerateText', () => {
  it('returns concatenated non-thought text and mapped usage, with no schema/mimetype in the body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Hello ' }, { text: 'world', thought: false }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, cachedContentTokenCount: 1 },
      }),
    );
    const { text, usage } = await geminiGenerateText({
      model: 'gemini-3-flash-preview',
      system: 'sys',
      user: 'usr',
      maxOutputTokens: 200,
      timeoutMs: 5000,
    });
    expect(text).toBe('Hello world');
    expect(usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(body.generationConfig.temperature).toBeUndefined();
  });

  it('propagates the same refusal/invalid_output error kinds as geminiGenerateJson', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { promptFeedback: { blockReason: 'OTHER' }, candidates: [] }));
    await expect(
      geminiGenerateText({ model: 'gemini-3-flash-preview', system: 's', user: 'u', maxOutputTokens: 100, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ kind: 'refusal' });
  });
});
