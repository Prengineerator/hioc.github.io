// PRN-1/D7-6 — pure validation tests for printers.json
// (desktop/src/printers/validate.ts, re-exported by store.ts). Imported by
// relative path (not the `@/` alias), same as escposStatus.test.ts, since it
// lives outside the `desktop/` TypeScript project that owns that alias
// mapping. validate.ts imports nothing from `electron`, so — unlike
// store.ts — it can be followed by the web app's TypeScript project too.
import { describe, expect, it } from 'vitest';
import { validatePrinterConfig, validatePrinterConfigs } from '../../desktop/src/printers/validate';
import type { PrinterConfig } from '@/lib/desktop/bridge';

function rawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'kitchen',
    name: 'Kitchen',
    connection: { kind: 'network', host: '10.0.0.5', port: 9100 },
    paperWidthMm: 80,
    roles: ['kot'],
    copies: {},
    cut: true,
    drawer: false,
    ...overrides,
  };
}

describe('validatePrinterConfig — cutMode', () => {
  it('defaults a config with no cutMode at all (pre-cutMode saved config) to "standard"', () => {
    const raw = rawConfig();
    expect('cutMode' in raw).toBe(false);
    const config = validatePrinterConfig(raw);
    expect(config.cutMode).toBe('standard');
  });

  it('preserves an explicit, valid cutMode', () => {
    for (const mode of ['standard', 'partial', 'full', 'legacy'] as const) {
      const config = validatePrinterConfig(rawConfig({ cutMode: mode }));
      expect(config.cutMode).toBe(mode);
    }
  });

  it('falls back an unknown cutMode value to "standard" rather than rejecting the printer', () => {
    const config = validatePrinterConfig(rawConfig({ cutMode: 'ultra-cut' }));
    expect(config.cutMode).toBe('standard');
  });

  it('falls back a non-string cutMode to "standard"', () => {
    const config = validatePrinterConfig(rawConfig({ cutMode: 42 }));
    expect(config.cutMode).toBe('standard');
  });

  it('never drops any other field while normalizing cutMode', () => {
    const config = validatePrinterConfig(rawConfig({ cutMode: 'legacy', drawer: true }));
    expect(config).toMatchObject({
      id: 'kitchen',
      name: 'Kitchen',
      paperWidthMm: 80,
      roles: ['kot'],
      cut: true,
      cutMode: 'legacy',
      drawer: true,
    });
  });
});

describe('validatePrinterConfigs — a whole saved list', () => {
  it('normalizes cutMode across a mixed list (some with it, some without, one invalid)', () => {
    const list = [
      rawConfig({ id: 'a', cutMode: 'partial' }),
      rawConfig({ id: 'b' }),
      rawConfig({ id: 'c', cutMode: 'not-a-real-mode' }),
    ];
    const configs: PrinterConfig[] = validatePrinterConfigs(list);
    expect(configs.map((c) => c.cutMode)).toEqual(['partial', 'standard', 'standard']);
  });
});
