import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { MAX_REPORT_BYTES } from '@/lib/online-settlements/detect';
import { ingestSettlementFile } from '@/lib/online-settlements/ingest';
import { supabaseSettlementStore } from '@/lib/online-settlements/store';
import type { Platform } from '@/lib/online-settlements/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/owner/online-reports/upload — owner only, multipart:
//   file      the report (.xlsx or .csv for Zomato; Swiggy files are saved for later)
//   platform  optional 'zomato' | 'swiggy' (else worked out from the file)
// For reports that never came by email, or older ones from before the mailbox
// was connected. Same pipeline as the mail check, so uploading a file that was
// also emailed is a harmless duplicate.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, 'Send the report as multipart form data with a "file" field');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return errorResponse(400, 'file field is required');
  if (file.size === 0) return errorResponse(400, 'The file is empty');
  if (file.size > MAX_REPORT_BYTES) return errorResponse(400, 'The file is larger than 15 MB');

  const hint = form.get('platform');
  let platformHint: Platform | null = null;
  if (hint === 'zomato' || hint === 'swiggy') platformHint = hint;
  else if (hint !== null && hint !== '') return errorResponse(400, "platform must be 'zomato' or 'swiggy'");

  try {
    const outcome = await ingestSettlementFile(supabaseSettlementStore(createAdminSupabaseClient()), {
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name || 'report.xlsx',
      source: 'upload',
      platformHint,
    });
    if (outcome.status === 'failed') return errorResponse(422, outcome.message ?? 'Could not read the report');
    return NextResponse.json({ outcome }, { status: outcome.status === 'read' ? 201 : 200 });
  } catch (err) {
    console.error('online-reports upload failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/online_settlement_/.test(msg)) return errorResponse(500, 'Apply supabase/2026-10-online-settlements.sql first');
    return errorResponse(500, 'Could not save the report');
  }
}
