import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';

export const dynamic = 'force-dynamic';

// DELETE /api/account/favorites/[menuItemId] — unheart an item (ACC-5).
export async function DELETE(
  _request: Request,
  { params }: { params: { menuItemId: string } },
) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  if (!isUuid(params.menuItemId)) {
    return errorResponse(400, 'menuItemId must be a valid uuid');
  }

  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('favorites')
    .delete()
    .eq('user_id', user.id)
    .eq('menu_item_id', params.menuItemId);

  if (error) {
    return errorResponse(500, 'Failed to remove favorite');
  }

  return NextResponse.json({ success: true });
}
