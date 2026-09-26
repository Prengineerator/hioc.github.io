// KOT counters settings screen (components/staff/settings/KotCountersSettings)
// — the pure conversion between the saved routing (lib/print/kotRouting.ts)
// and the form the screen edits: a list of counters plus ONE counter choice per
// menu category. Choosing per category (rather than ticking categories under
// each counter) makes "a category belongs to one counter" impossible to break
// from the screen in the first place.

import type { KotRouting } from '@/lib/print/kotRouting';

export interface KotCounterDraft {
  /** Stable React/form key; never saved. */
  key: string;
  name: string;
}

export interface KotCountersForm {
  counters: KotCounterDraft[];
  /** category -> counter key, or '' for the "Other items" slip. */
  assignment: Record<string, string>;
  fullCopy: boolean;
  /** Every category the screen lists: the menu's, then any saved ones no
   * longer on the menu (kept so a save doesn't silently drop them). */
  categories: string[];
}

export function routingToForm(routing: KotRouting, menuCategories: string[]): KotCountersForm {
  const counters = routing.counters.map((c, i) => ({ key: `c${i + 1}`, name: c.name }));
  const assignment: Record<string, string> = {};
  const categories = [...menuCategories];
  const known = new Set(menuCategories.map((c) => c.toLowerCase()));
  routing.counters.forEach((c, i) => {
    for (const cat of c.categories) {
      const onMenu = menuCategories.find((m) => m.toLowerCase() === cat.toLowerCase());
      if (onMenu) assignment[onMenu] = counters[i].key;
      else if (!known.has(cat.toLowerCase())) {
        known.add(cat.toLowerCase());
        categories.push(cat);
        assignment[cat] = counters[i].key;
      }
    }
  });
  for (const cat of categories) assignment[cat] ??= '';
  return { counters, assignment, fullCopy: routing.full_copy, categories };
}

/** The request body for PUT /api/pos/kot-routing (validated again server-side). */
export function formToRouting(form: KotCountersForm): KotRouting {
  return {
    counters: form.counters.map((c) => ({
      name: c.name.trim(),
      categories: form.categories.filter((cat) => form.assignment[cat] === c.key),
    })),
    full_copy: form.fullCopy,
  };
}

/** A fresh key for a newly added counter, unique within the form. */
export function nextCounterKey(counters: KotCounterDraft[]): string {
  let n = counters.length + 1;
  while (counters.some((c) => c.key === `c${n}`)) n++;
  return `c${n}`;
}
