import { SettleWorkspace } from '@/components/staff/SettleWorkspace';

// "Settle" — every unpaid bill from any day, each settled in place with the
// same payment step as New order (cash + change, UPI, card, split).
export default function StaffSettlePage() {
  return <SettleWorkspace />;
}
