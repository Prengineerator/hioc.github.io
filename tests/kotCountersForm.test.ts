import { describe, expect, it } from 'vitest';
import { formToRouting, nextCounterKey, routingToForm } from '@/lib/staff/kotCountersForm';

// The KOT counters screen edits one counter choice per category; these pin the
// round trip between that form and the saved setup.

describe('routingToForm / formToRouting', () => {
  const menu = ['Coffee', 'Iced Coffee', 'Stick Waffles', 'Eatery'];

  it('round-trips a saved setup, leaving unassigned categories on Other items', () => {
    const saved = {
      counters: [
        { name: 'Coffee Bar', categories: ['Coffee', 'Iced Coffee'] },
        { name: 'Waffles', categories: ['Stick Waffles'] },
      ],
      full_copy: true,
    };
    const form = routingToForm(saved, menu);
    expect(form.assignment).toEqual({ Coffee: 'c1', 'Iced Coffee': 'c1', 'Stick Waffles': 'c2', Eatery: '' });
    expect(formToRouting(form)).toEqual(saved);
  });

  it('keeps a saved category that is no longer on the menu, so saving does not drop it', () => {
    const form = routingToForm({ counters: [{ name: 'Bar', categories: ['Seasonal'] }], full_copy: false }, menu);
    expect(form.categories).toEqual([...menu, 'Seasonal']);
    expect(formToRouting(form).counters[0].categories).toEqual(['Seasonal']);
  });

  it('maps a saved category to the menu spelling regardless of case', () => {
    const form = routingToForm({ counters: [{ name: 'Bar', categories: ['coffee'] }], full_copy: false }, menu);
    expect(form.assignment.Coffee).toBe('c1');
    expect(form.categories).toEqual(menu);
  });

  it('trims counter names on the way out', () => {
    const form = routingToForm({ counters: [], full_copy: false }, menu);
    form.counters.push({ key: 'c1', name: '  Kitchen ' });
    form.assignment.Eatery = 'c1';
    expect(formToRouting(form).counters).toEqual([{ name: 'Kitchen', categories: ['Eatery'] }]);
  });
});

describe('nextCounterKey', () => {
  it('never reuses a key still in the form', () => {
    expect(nextCounterKey([])).toBe('c1');
    expect(nextCounterKey([{ key: 'c2', name: '' }])).toBe('c3');
    expect(nextCounterKey([{ key: 'c1', name: '' }, { key: 'c3', name: '' }])).toBe('c4');
  });
});
