// Reads a menu spreadsheet saved as CSV (Excel, Google Sheets, Numbers) for
// the menu import. The server checks every row again (adminImportMenu).

// Splits CSV text into rows of cells. Handles quoted cells with commas,
// quotes ("") and line breaks, Windows line endings, a byte-order mark, and
// the semicolon or tab separators some spreadsheet apps use.
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] || '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const separator = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

export type MenuRow = {
  title: string;
  price: string;
  category: string;
  description: string;
  prepMinutes: string;
};

// Column names people use for each field (compared lower-case, without
// punctuation).
const COLUMNS: Record<keyof MenuRow, string[]> = {
  title: ['name', 'dish', 'title', 'item', 'menu item', 'dish name', 'item name'],
  price: ['price', 'amount', 'cost', 'selling price', 'unit price'],
  category: ['category', 'section', 'group', 'type', 'menu section'],
  description: ['description', 'details', 'notes', 'desc'],
  prepMinutes: ['prep', 'prep time', 'prep minutes', 'preparation time', 'minutes', 'prep mins'],
};
const clean = (header: string) =>
  header
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The dishes in a parsed CSV. The first row must name the columns; name and
// price are required, the rest optional.
export function menuRowsFromCsv(table: string[][]): { rows: MenuRow[]; problem: string } {
  if (table.length < 2)
    return { rows: [], problem: 'The file needs a header row and at least one dish' };
  const headers = table[0].map(clean);
  const index = Object.fromEntries(
    (Object.keys(COLUMNS) as (keyof MenuRow)[]).map((field) => [
      field,
      headers.findIndex((header) => COLUMNS[field].includes(header)),
    ]),
  ) as Record<keyof MenuRow, number>;
  const missing = (['title', 'price'] as const).filter((field) => index[field] < 0);
  if (missing.length)
    return {
      rows: [],
      problem: `Add a column called ${missing.map((field) => (field === 'title' ? '"Name"' : '"Price"')).join(' and ')} to the first row`,
    };
  const cell = (cells: string[], field: keyof MenuRow) =>
    index[field] < 0 ? '' : (cells[index[field]] ?? '').trim();
  return {
    rows: table.slice(1).map((cells) => ({
      title: cell(cells, 'title'),
      price: cell(cells, 'price'),
      category: cell(cells, 'category'),
      description: cell(cells, 'description'),
      prepMinutes: cell(cells, 'prepMinutes'),
    })),
    problem: '',
  };
}

// A starter file for people to fill in.
export const MENU_TEMPLATE = [
  'Name,Price,Category,Description,Prep minutes',
  'Chicken stew,15000,Mains,Served with rice or matooke,20',
  'Beef pilau,14000,Mains,,25',
  'Passion juice,5000,Drinks,Fresh,',
].join('\r\n');

// Writes rows as CSV that Excel opens correctly (byte-order mark, quoted
// cells, Windows line endings). Cells starting with = + - @ are prefixed with
// ' so a spreadsheet never runs them as formulas.
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return String(value);
    const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (
    String.fromCharCode(0xfeff) +
    [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
  );
}
