import { NextResponse } from 'next/server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseSettingsPatch, validateMergedSettings } from '@/lib/marketing/parse';
import { DEFAULT_SETTINGS } from '@/lib/marketing/types';
import type { SettingsResponse } from '@/lib/marketing/types';
import { ownerRoute } from '@/lib/marketing/server/http';
import { loadSettings, marketingAdmin, saveSettings } from '@/lib/marketing/server/repo';

export const dynamic = 'force-dynamic';

// GET / PATCH /api/owner/marketing/settings — the singleton the owner edits: the kill
// switch, budget, message cost, send window, caps, holdout. OWNER ONLY.

export async function GET() {
  return ownerRoute(async () => {
    const settings = (await loadSettings(marketingAdmin())) ?? DEFAULT_SETTINGS;
    return NextResponse.json({ settings } satisfies SettingsResponse);
  });
}

export async function PATCH(request: Request) {
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const parsed = parseSettingsPatch(body);
    if (!parsed.ok) return errorResponse(400, parsed.error);

    const admin = marketingAdmin();
    const current = (await loadSettings(admin)) ?? DEFAULT_SETTINGS;
    // A patch may carry only one side of the send window: check the window that WOULD result.
    const merged = { ...current, ...parsed.value };
    const crossField = validateMergedSettings(merged);
    if (crossField) return errorResponse(400, crossField);

    const settings = await saveSettings(admin, parsed.value, owner.id);
    return NextResponse.json({ settings } satisfies SettingsResponse);
  });
}
