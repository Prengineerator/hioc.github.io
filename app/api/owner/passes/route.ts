import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { PLAN_COLUMNS, toCoffeePassPlan } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

// GET /api/owner/passes — owner only (Owner → Passes). What the page edits:
//
//   plans        EVERY plan, active or not, in the owner's sort_order (then price)
//   eligible_ids the menu items a pass can pay for (menu_items.pass_eligible)
//   menu         every menu item for the picker: { id, name, category,
//                is_available }, by category and then the menu's own order, so the
//                picker groups by category and offers "select the whole category"
//
// getOwnerUser() ONLY (rule D6-6): a 4-digit PIN on shared counter hardware must
// never reach the plans and prices, so this never accepts a device operator.
export async function GET() {
  const off = coffeePassDisabled();
  if (off) return off;

  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const [plans, menu] = await Promise.all([
    admin.from('coffee_pass_plans').select(PLAN_COLUMNS),
    admin
      .from('menu_items')
      .select('id, name, category, is_available, sort_order, pass_eligible')
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
  ]);
  const failed = plans.error ?? menu.error;
  if (failed) {
    console.error('GET /api/owner/passes: read failed', failed);
    return errorResponse(
      500,
      isMissingPassSchema(failed) ? `Could not load the plans — ${PASS_MIGRATION_HINT}` : 'Could not load the plans.',
    );
  }

  const menuRows = (menu.data ?? []) as {
    id: string;
    name: string;
    category: string;
    is_available: boolean;
    pass_eligible: boolean;
  }[];

  return NextResponse.json({
    plans: ((plans.data ?? []) as unknown as Record<string, unknown>[])
      .map(toCoffeePassPlan)
      .sort((a, b) => a.sort_order - b.sort_order || a.price_inr - b.price_inr || a.name.localeCompare(b.name)),
    eligible_ids: menuRows.filter((m) => m.pass_eligible === true).map((m) => m.id),
    menu: menuRows.map((m) => ({ id: m.id, name: m.name, category: m.category, is_available: m.is_available !== false })),
  });
}
