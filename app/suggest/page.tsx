// /suggest — "Ask Coffey", the suggestion wizard (SUG-7, COFFEY-SPEC §1).
// A server component so it can read the menu once and tell the wizard which
// flavour chips the menu can actually serve. Flag-gated: when flags.suggest is
// off this renders only the coming-soon state and makes NO database call. The
// page title lives in ./layout.tsx.

import { SuggestComingSoon } from '@/components/suggest/ComingSoon';
import { flags } from '@/lib/flags';
import { menuFacets, type MenuFacet } from '@/lib/suggest/facets';
import { flavourCountsByKind } from '@/lib/suggest/flavor';
import { loadMenuAndTraits } from '@/lib/suggest/serverData';
import type { FlavourCounts } from '@/lib/suggest/types';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SuggestPageClient } from './SuggestPageClient';

// Counts follow the live menu (the loader keeps its own 60 s cache).
export const dynamic = 'force-dynamic';

export default async function SuggestPage() {
  if (!flags.suggest) {
    return <SuggestComingSoon />;
  }

  // null = "offer every family": a failed or empty read must never block the wizard.
  let flavourCounts: FlavourCounts | null = null;
  let facets: MenuFacet[] | null = null;
  try {
    const { items, traitsById, addonTraitsById } = await loadMenuAndTraits(createAdminSupabaseClient());
    if (items.length > 0) {
      flavourCounts = flavourCountsByKind(items, traitsById, addonTraitsById);
      const built = menuFacets(items, traitsById, addonTraitsById);
      facets = built.length > 0 ? built : null;
    }
  } catch {
    flavourCounts = null;
    facets = null;
  }

  return <SuggestPageClient flavourCounts={flavourCounts} facets={facets} />;
}
