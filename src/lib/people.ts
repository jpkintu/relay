import type Parse from '../parse';

// "R-001 · Rita Rider" for a fetched/included _User pointer.
export function personLabel(user: Parse.Object | undefined | null): string {
  if (!user) return 'Unknown';
  const name = user.get('name') || user.get('username');
  const code = user.get('riderCode') || user.get('cashierCode');
  if (!name) return code || 'Unknown';
  return code ? `${code} · ${name}` : name;
}
