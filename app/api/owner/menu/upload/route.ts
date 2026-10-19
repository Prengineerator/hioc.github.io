import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { uploadMenuImage } from '@/lib/menu/applyMenuChange';

export const dynamic = 'force-dynamic';

// POST /api/owner/menu/upload — owner only. multipart/form-data with a `file`
// field; same validation, bucket and response ({ url }, 201) as
// POST /api/menu/upload, for the owner app's menu editor (no POS device).
//
// getOwnerUser() ONLY (rule D6-6).
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  return uploadMenuImage(request, createAdminSupabaseClient());
}
