// The pages inside Admin (behind the owner's PIN), in menu order.
export const ADMIN_TABS = [
  ['settings', 'Settings'],
  ['branding', 'Branding'],
  ['payments', 'Payments'],
  ['tax', 'Tax (EFRIS)'],
  ['whatsapp', 'WhatsApp'],
  ['access', 'Access rules'],
  ['audit', 'Audit log'],
  ['errors', 'Errors'],
  ['data', 'Data & privacy'],
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number][0];
