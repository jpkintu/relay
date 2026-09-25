// Order-entry cart helpers. Pure functions, unit-tested. The server re-checks
// everything (prices, availability, accompaniment rules, commission).

export type AccompanimentOption = { id: string; title: string };
export type AccompanimentGroup = {
  label: string;
  min: number;
  max: number;
  options: AccompanimentOption[];
};
export type MenuItem = {
  id: string;
  title: string;
  category: string;
  price: number;
  accompanimentGroups: AccompanimentGroup[];
  color?: string;
};
export type CartLine = {
  key: string;
  itemId: string;
  title: string;
  price: number;
  quantity: number;
  notes: string;
  accompaniments: AccompanimentOption[];
};

// Same dish + same accompaniments + same notes → one line with a quantity.
export function lineKey(itemId: string, accompanimentIds: string[], notes: string): string {
  return [itemId, [...accompanimentIds].sort().join('+'), notes.trim().toLowerCase()].join('|');
}

export function addToCart(
  cart: CartLine[],
  item: Pick<MenuItem, 'id' | 'title' | 'price'>,
  quantity: number,
  accompaniments: AccompanimentOption[] = [],
  notes = '',
): CartLine[] {
  const key = lineKey(
    item.id,
    accompaniments.map((a) => a.id),
    notes,
  );
  const existing = cart.find((line) => line.key === key);
  if (existing)
    return cart.map((line) =>
      line.key === key ? { ...line, quantity: line.quantity + quantity } : line,
    );
  return [
    ...cart,
    {
      key,
      itemId: item.id,
      title: item.title,
      price: item.price,
      quantity,
      notes: notes.trim(),
      accompaniments,
    },
  ];
}

export function changeQuantity(cart: CartLine[], key: string, delta: number): CartLine[] {
  return cart
    .map((line) => (line.key === key ? { ...line, quantity: line.quantity + delta } : line))
    .filter((line) => line.quantity > 0);
}

export const cartCount = (cart: CartLine[]) => cart.reduce((n, line) => n + line.quantity, 0);
export const cartSubtotal = (cart: CartLine[]) =>
  cart.reduce((n, line) => n + line.price * line.quantity, 0);

// Mirrors cloud/lib/accompaniments.js selectionError for the picker.
export function selectionProblem(groups: AccompanimentGroup[], selected: string[]): string {
  for (const group of groups) {
    const count = group.options.filter((option) => selected.includes(option.id)).length;
    if (count > group.max)
      return group.max === 1
        ? `Choose only one ${group.label.toLowerCase()} option`
        : `Choose at most ${group.max} from ${group.label}`;
    if (count < group.min) return `Choose at least ${group.min} from ${group.label}`;
  }
  return '';
}

// Toggle an option, respecting "pick at most": a single-choice group swaps.
export function toggleOption(group: AccompanimentGroup, selected: string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  const inGroup = selected.filter((s) => group.options.some((o) => o.id === s));
  if (group.max === 1) return [...selected.filter((s) => !inGroup.includes(s)), id];
  if (inGroup.length >= group.max) return selected;
  return [...selected, id];
}

// Mirrors cloud/lib/money.js computeCommission, for the "You'll earn" preview.
const ROUNDING_STEPS: Record<string, number> = { up_100: 100, up_500: 500, up_1000: 1000 };
export function previewCommission(
  commission: { type: string; perOrder: number; percent: number } | null | undefined,
  subtotal: number,
  rounding = 'none',
): number {
  if (!commission) return 0;
  const share = (subtotal * (commission.percent || 0)) / 100;
  const flat = commission.perOrder || 0;
  const raw =
    commission.type === 'percent' ? share : commission.type === 'hybrid' ? flat + share : flat;
  const whole = Math.round(raw);
  const step = ROUNDING_STEPS[rounding] || 0;
  return step ? Math.ceil(whole / step) * step : whole;
}

export function describeLine(line: Pick<CartLine, 'accompaniments' | 'notes'>): string {
  return [line.accompaniments.map((a) => a.title).join(', '), line.notes]
    .filter(Boolean)
    .join(' · ');
}
