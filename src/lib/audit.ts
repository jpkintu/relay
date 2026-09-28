// Plain-language names for audit log actions (cloud: audit(actor, action, …)).

const ACTIONS: Record<string, string> = {
  'order.placed': 'Placed the order',
  'order.accept': 'Accepted in the kitchen',
  'order.prepare': 'Started preparing',
  'order.ready': 'Marked ready',
  'order.pickup': 'Handed to the rider',
  'order.deliver': 'Delivered',
  'order.reject': 'Rejected',
  'order.cancel': 'Cancelled',
  'order.transferred': 'Passed to another cashier',
  'order.issue_flagged': 'Reported a problem',
  'order.issue_resolved': 'Resolved a problem',
  'order.override_cancel': 'Owner cancelled the order',
  'order.override_payment': 'Owner changed the payment',
  'order.override_deliver': 'Owner marked it delivered',
  'order.override_reopen': 'Owner undid the delivery',
  'order.override_move': 'Owner moved it to another rider',
  'payment.verified': 'Mobile money confirmed',
  'payment.rejected': 'Mobile money not received',
  'payment.resubmitted': 'Sent a new transaction ID',
  'cash.handover_created': 'Handed over cash',
  'cash.handover_confirmed': 'Counted a cash handover',
  'cash.handover_disputed': 'Disputed a cash handover',
  'cash.dispute_reopened': 'Reopened a disputed handover',
  'cash.dispute_write_off': 'Wrote off a cash shortage',
  'cash.dispute_deduct': 'Charged a shortage to the rider',
  'cash.dispute_reopen': 'Reopened a handover for a recount',
  'cash.received_by_owner': 'Owner took a rider’s cash',
  'payout.rider': 'Paid a rider',
  'payout.rider_fees': 'Paid delivery fees at the handover',
  'payout.expense': 'Took cash out of the till',
  'payout.requested': 'Asked to be paid',
  'shift.started': 'Started a shift',
  'shift.closed': 'Ended a shift',
  'team.created': 'Added a team member',
  'team.updated': 'Changed a team member',
  'team.role_changed': 'Changed a role',
  'team.pin_changed': 'Changed their PIN',
  'team.pin_reset': 'Reset a PIN',
  'rider.availability': 'Changed availability',
  'menu.saved': 'Saved a dish',
  'menu.imported': 'Imported dishes from a spreadsheet',
  'setup.finished': 'Finished or reopened Get started',
  'errors.resolved': 'Marked errors as fixed',
  'data.exported': 'Downloaded data',
  'privacy.settings_saved': 'Changed the privacy settings',
  'privacy.retention': 'Removed old customer details',
  'privacy.customer_forgotten': 'Removed a customer’s details on request',
  'menu.archived': 'Archived a dish',
  'menu.sorted': 'Reordered the menu',
  'menu.image': 'Changed a dish photo',
  'menu.category_saved': 'Saved a category',
  'menu.accompaniment_saved': 'Saved an accompaniment',
  'stock.available': 'Back in stock',
  'stock.sold_out': 'Marked sold out',
  'configuration.saved': 'Saved settings',
  'security.applied': 'Applied security rules',
  'owner.initialized': 'Set up the owner',
  'report.z_saved': 'Saved a Z-report',
  'code.repaired': 'Repaired a broken code',
};

export const actionLabel = (action: string) => ACTIONS[action] ?? action.replace(/[._]/g, ' ');

export const AUDIT_GROUP_LABEL: Record<string, string> = {
  order: 'Orders',
  payment: 'Mobile money',
  cash: 'Cash handovers',
  payout: 'Payouts',
  shift: 'Shifts',
  team: 'Team',
  rider: 'Rider status',
  menu: 'Menu',
  stock: 'Stock',
  configuration: 'Settings',
  security: 'Security',
  owner: 'Owner setup',
  report: 'Reports',
  setup: 'Get started',
  errors: 'Errors',
  data: 'Data exports',
  privacy: 'Privacy',
};

// Fields that changed between two audit snapshots, for a short diff. The
// "after" snapshot names what the action set; "before" may hold more.
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(after).length ? Object.keys(after) : Object.keys(before);
  const show = (value: unknown) =>
    value === undefined || value === null || value === ''
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return keys
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({
      key,
      before: key in before ? show(before[key]) : null,
      after: show(after[key]),
    }));
}
