// The browser's side of trial-and-subscription.
//
// The server is the only authority on whether a teacher may teach — this file
// exists so the UI can *explain* the answer, not decide it. Every gate that
// matters is enforced again when the socket claims the teacher seat, so a
// teacher who edits their way past this screen gains nothing.
import { api } from './api';

export type AccessState = 'trial' | 'active' | 'expired';

export interface PendingClaim {
  id: string;
  amount_rupees: number;
  months: number;
  reference: string | null;
  claimed_at: string;
}

export interface BillingStatus {
  state: AccessState;
  /** ISO date the current entitlement runs out. */
  until: string | null;
  daysLeft: number;
  priceRupees: number;
  trialDays: number;
  admin: boolean;
  pendingClaim: PendingClaim | null;
  upiId: string | null;
  payeeName: string;
}

export interface ClaimRow extends PendingClaim {
  teacher_id: string;
  teacher_email: string;
  note: string | null;
  confirmed_at: string | null;
  confirmed_by: string | null;
  rejected_at: string | null;
  rejected_note: string | null;
  paid_until: string | null;
}

export const getBillingStatus = () => api.get<BillingStatus>('/api/billing/status');

export const claimPayment = (reference: string, months: number, note?: string) =>
  api.post<{ ok: true; claim: PendingClaim }>('/api/billing/claim', { reference, months, note });

export const listClaims = () =>
  api.get<{ claims: ClaimRow[] }>('/api/admin/claims');

export const confirmClaim = (id: string) =>
  api.post<{ ok: true; paidUntil: string }>(`/api/admin/claims/${id}/confirm`);

export const rejectClaim = (id: string, note?: string) =>
  api.post<{ ok: true }>(`/api/admin/claims/${id}/reject`, { note });

export const grantMonths = (email: string, months: number) =>
  api.post<{ ok: true; paidUntil: string }>('/api/admin/grant', { email, months });

/** "3 days left", "today", "until 14 Oct" — one phrase the UI can drop in. */
export function describe(s: BillingStatus): string {
  if (s.state === 'active') {
    return s.until
      ? `Subscribed until ${new Date(s.until).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : 'Subscribed';
  }
  if (s.state === 'trial') {
    if (s.daysLeft <= 1) return 'Free trial ends today';
    return `Free trial — ${s.daysLeft} days left`;
  }
  return 'Free trial ended';
}
