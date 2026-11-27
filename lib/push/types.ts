// Shapes shared by the push routes and the screens that call them.

export const PUSH_TITLE_MAX = 40;
export const PUSH_BODY_MAX = 120;

export interface PushSendRow {
  id: string;
  title: string;
  body: string;
  url: string;
  kind: 'broadcast' | 'test';
  device_count: number;
  delivered: number;
  failed: number;
  clicked: number;
  created_at: string;
}

export interface PushSummary {
  /** VAPID keys are present on the server. */
  configured: boolean;
  customers: number;
  devices: number;
  /** The owner's own signed-up phones (what Send test reaches). */
  own_devices: number;
  /** A broadcast has already gone out today (IST). */
  sent_today: boolean;
  recent: PushSendRow[];
}

export interface PushSendResult {
  ok: true;
  send_id: string;
  device_count: number;
  delivered: number;
  failed: number;
  removed: number;
  /** Not tried because the time budget ran out (counted in failed). */
  skipped: number;
}

export interface PushStatus {
  subscribed: boolean;
  devices: number;
}
