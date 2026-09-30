import Parse from '../parse';

// Limits a query to one branch (a cashier's own); no-op without one.
export function inBranch<T extends Parse.Query>(query: T, branchId?: string | null): T {
  if (!branchId) return query;
  const branch = new Parse.Object('Branch');
  branch.id = branchId;
  query.equalTo('branch', branch);
  return query;
}
