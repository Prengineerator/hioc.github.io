import { describe, expect, it } from 'vitest';
import {
  claimRemovedReport,
  eventForAdd,
  findAddedLine,
  presetOutcome,
  snapshotLines,
  type CartLineLike,
} from '@/components/suggest/presetEvents';

const line = (over: Partial<CartLineLike> & { key: string }): CartLineLike => ({
  menuItemId: 'latte',
  qty: 1,
  addons: [],
  ...over,
});

describe('presetOutcome', () => {
  it('kept when at least one preset option is on the line', () => {
    expect(presetOutcome(['hazelnut', 'shot'], ['shot', 'oat'])).toBe('kept');
  });
  it('removed when none is', () => {
    expect(presetOutcome(['hazelnut'], ['oat'])).toBe('removed');
    expect(presetOutcome(['hazelnut'], [])).toBe('removed');
  });
});

describe('claimRemovedReport (once per pick)', () => {
  it('is true once per pick, false after, and a cleared set starts over', () => {
    const reported = new Set<string>();
    expect(claimRemovedReport(reported, 'latte')).toBe(true);
    expect(claimRemovedReport(reported, 'latte')).toBe(false);
    expect(claimRemovedReport(reported, 'mocha')).toBe(true);
    const next = new Set<string>();
    expect(claimRemovedReport(next, 'latte')).toBe(true);
  });
});

describe('eventForAdd', () => {
  it('kept / removed from the line', () => {
    expect(eventForAdd(['h'], ['h'], false)).toBe('preset_kept');
    expect(eventForAdd(['h'], [], false)).toBe('preset_removed');
  });
  it('does not repeat a removal already reported, but still reports a keep', () => {
    expect(eventForAdd(['h'], [], true)).toBeNull();
    expect(eventForAdd(['h'], ['h'], true)).toBe('preset_kept');
  });
  it('sends neither when the line is unknown or the pick had no add-on presets', () => {
    expect(eventForAdd(['h'], null, false)).toBeNull();
    expect(eventForAdd([], [], false)).toBeNull();
  });
});

describe('findAddedLine', () => {
  const before = snapshotLines([line({ key: 'k-old', qty: 2 })]);

  it('finds a new line carrying this session id', () => {
    const added = line({ key: 'k-new', suggestionSessionId: 'S', addons: [{ optionId: 'h' }] });
    expect(findAddedLine(before, [line({ key: 'k-old', qty: 2 }), added], 'latte', 'S')).toBe(added);
  });
  it('finds a merged line by its qty growth, whatever session id it kept', () => {
    const merged = line({ key: 'k-old', qty: 3 });
    expect(findAddedLine(before, [merged], 'latte', 'S')).toBe(merged);
  });
  it('is null when the new line has another session id (or none)', () => {
    expect(findAddedLine(before, [line({ key: 'k-new' })], 'latte', 'S')).toBeNull();
    expect(findAddedLine(before, [line({ key: 'k-new', suggestionSessionId: 'T' })], 'latte', 'S')).toBeNull();
  });
  it('is null when nothing changed or two lines changed (ambiguous)', () => {
    expect(findAddedLine(before, [line({ key: 'k-old', qty: 2 })], 'latte', 'S')).toBeNull();
    expect(
      findAddedLine(
        before,
        [line({ key: 'a', suggestionSessionId: 'S' }), line({ key: 'b', suggestionSessionId: 'S' })],
        'latte',
        'S',
      ),
    ).toBeNull();
  });
  it('ignores other menu items', () => {
    expect(findAddedLine(before, [line({ key: 'x', menuItemId: 'mocha', suggestionSessionId: 'S' })], 'latte', 'S')).toBeNull();
  });
});
