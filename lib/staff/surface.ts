import 'server-only';
import { getEnrolledDevice } from '@/lib/api/device';
import type { StaffSurface } from '@/lib/staff/surfaceRules';

/**
 * 'pos' when this request comes from an enrolled, unrevoked counter device
 * (its httpOnly device cookie — lib/api/device.ts), else 'web'. The cookie is
 * issued only by device enrolment, so a staffer can't make a phone "the POS"
 * by editing anything client-side.
 */
export async function getStaffSurface(): Promise<StaffSurface> {
  return (await getEnrolledDevice()) ? 'pos' : 'web';
}
