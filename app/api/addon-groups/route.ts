import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import type { AddonGroup } from '@/lib/types';

export const dynamic = 'force-dynamic';

// GET /api/addon-groups — public. The full library of customization groups
// (e.g. "Choice of Sugar", "Choose Milk"), used by the staff menu item form
// to pick which groups apply to a given item. Menu browsing itself gets
// addon groups embedded per-item via GET /api/menu, not from this route.
export async function GET() {
  const supabase = createServerSupabaseClient();

  const { data, error } = await supabase
    .from('addon_groups')
    .select('*, options:addon_options(*)')
    .order('sort_order', { ascending: true });

  if (error) {
    return errorResponse(500, 'Failed to load addon groups');
  }

  const groups = (data ?? []).map((g) => ({
    ...g,
    options: [...(g.options ?? [])].sort(
      (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order,
    ),
  })) as AddonGroup[];

  return NextResponse.json({ addonGroups: groups });
}
