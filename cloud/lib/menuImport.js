// Checks the rows of a menu import (Admin → Get started, or Menu → Import)
// before anything is saved. Rows come from a spreadsheet (CSV) the app has
// already split into { title, price, category, description, prepMinutes }.

const MAX_ROWS = 500;

// "12,000", "UGX 12 000", "12000.00" → 12000. Anything else → NaN.
function parsePrice(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '')
    .replace(/[^\d.,-]/g, '')
    .replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN;
  return Number(text);
}

const text = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// Returns { rows, errors }: rows ready to save (with their spreadsheet row
// number, counting the header as row 1), errors as { row, message }.
function checkImportRows(input) {
  if (!Array.isArray(input) || !input.length)
    return { rows: [], errors: [{ row: 0, message: 'The file has no dishes' }] };
  if (input.length > MAX_ROWS)
    return {
      rows: [],
      errors: [{ row: 0, message: `Import at most ${MAX_ROWS} dishes at a time` }],
    };
  const rows = [];
  const errors = [];
  const seen = new Map();
  input.forEach((raw, index) => {
    const row = index + 2;
    const title = text(raw?.title, 120);
    const category = text(raw?.category, 80) || 'Mains';
    const description = String(raw?.description ?? '')
      .trim()
      .slice(0, 300);
    const price = parsePrice(raw?.price);
    const prepText = String(raw?.prepMinutes ?? '').trim();
    const prepMinutes = prepText === '' ? undefined : Number(prepText);
    if (!title) return errors.push({ row, message: 'The dish has no name' });
    if (!Number.isFinite(price) || price < 0 || price > 100000000)
      return errors.push({ row, message: `"${title}": the price is not a number` });
    if (
      prepMinutes !== undefined &&
      (!Number.isInteger(prepMinutes) || prepMinutes < 0 || prepMinutes > 240)
    )
      return errors.push({ row, message: `"${title}": prep time must be whole minutes, 0 to 240` });
    const key = title.toLowerCase();
    if (seen.has(key))
      return errors.push({ row, message: `"${title}" is already on row ${seen.get(key)}` });
    seen.set(key, row);
    rows.push({ row, title, price, category, description, prepMinutes });
  });
  return { rows, errors };
}

module.exports = { checkImportRows, parsePrice, MAX_ROWS };
