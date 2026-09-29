// Records restored from a backup (Admin → Data & privacy → Restore) are new
// records to Parse, which does not let Cloud Code set createdAt. They keep
// their original creation time in `restoredCreatedAt`; reports and lists read
// it through these helpers so a restored year of orders is not "today".

// When a record was really created.
const placedAt = (row) => row?.get?.('restoredCreatedAt') || row?.createdAt || null;

// A query for records created in [start, end), counting restored records by
// their original time. Either end may be left open.
function createdIn(className, { start, end } = {}) {
  const live = new Parse.Query(className);
  if (start) live.greaterThanOrEqualTo('createdAt', start);
  if (end) live.lessThan('createdAt', end);
  live.doesNotExist('restoredCreatedAt');
  const restored = new Parse.Query(className);
  restored.exists('restoredCreatedAt');
  if (start) restored.greaterThanOrEqualTo('restoredCreatedAt', start);
  if (end) restored.lessThan('restoredCreatedAt', end);
  return Parse.Query.or(live, restored);
}

module.exports = { placedAt, createdIn };
