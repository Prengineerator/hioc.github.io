import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { ownerLoginEmails } from '@/lib/reports/ownerDigestServer';
import {
  alertChannelHealth,
  alertRecipients,
  loadAlertSettings,
  parseAlertSettingsPatch,
  recentAlerts,
  saveAlertSettings,
} from '@/lib/inventory/ownerAlerts';
import { inventoryWriteFailure } from '@/lib/inventory/api';
import { requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

// Owner → Warehouse → Alerts (docs/WAREHOUSE-SPEC.md, WH-D9..D11). OWNER ONLY.
// GET   the settings, who an alert would reach right now, whether email and
//       WhatsApp are configured, and the latest attempts.
// PATCH { enabled?, emailOwnerLogins?, emails?, whatsappPhones? } — lists are
//       replaced whole.

async function view(admin: ReturnType<typeof createAdminSupabaseClient>) {
  const [{ settings, migrated }, ownerEmails, log] = await Promise.all([
    loadAlertSettings(admin),
    ownerLoginEmails(admin),
    recentAlerts(admin),
  ]);
  return { settings, migrated, ownerEmails, recipients: alertRecipients(settings, ownerEmails), health: alertChannelHealth(), log };
}

export async function GET() {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  return NextResponse.json(await view(createAdminSupabaseClient()));
}

export async function PATCH(request: Request) {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseAlertSettingsPatch(body);
  if (!parsed.ok) return errorResponse(400, parsed.message);
  const admin = createAdminSupabaseClient();
  const saved = await saveAlertSettings(admin, parsed.patch, gate.owner.id);
  if ('error' in saved) return inventoryWriteFailure(saved.error, 'Saving the alert settings');
  return NextResponse.json(await view(admin));
}
