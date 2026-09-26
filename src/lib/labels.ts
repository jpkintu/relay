// Human labels and tones for status values shown in tables and pills.

export const ORDER_STATUS: Record<string, string> = {
  PLACED: 'Placed',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY: 'Ready',
  PICKED_UP: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const statusLabel = (status: string) => ORDER_STATUS[status] ?? status;

// good / bad / '' (neutral) for the status pill colour.
export function statusTone(status: string): '' | 'good' | 'bad' {
  if (['DELIVERED', 'RECONCILED', 'VERIFIED', 'confirmed'].includes(status)) return 'good';
  if (['CANCELLED', 'REJECTED', 'disputed'].includes(status)) return 'bad';
  return '';
}
