// Accompaniment rules. Pure functions (no Parse), unit-tested.
//
// A menu item carries `accompanimentGroups`, e.g. for "Chicken stew":
//   [{ label: 'Rice',  options: [vegRiceId, friedRiceId],        min: 0, max: 1 },
//    { label: 'Sides', options: [matookeId, pumpkinId, yamsId],  min: 0, max: 3 }]
// Accompaniments are free. `max: 1` is how "one or the other, not both" is
// expressed.

const MAX_GROUPS = 6;
const MAX_OPTIONS = 20;

// Validates and cleans groups entered by the admin. `knownIds` is the set of
// existing accompaniment ids. Throws an Error with a user-facing message.
function normalizeGroups(raw, knownIds) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_GROUPS)
    throw new Error(`Use at most ${MAX_GROUPS} accompaniment groups`);
  return raw.map((group, index) => {
    const label = String(group?.label || '').trim() || `Choice ${index + 1}`;
    if (label.length > 40)
      throw new Error('Accompaniment group names must be 40 characters or less');
    const options = [...new Set((group?.options || []).map(String))];
    if (!options.length) throw new Error(`"${label}" needs at least one accompaniment`);
    if (options.length > MAX_OPTIONS)
      throw new Error(`"${label}" can offer at most ${MAX_OPTIONS} accompaniments`);
    const unknown = options.filter((id) => !knownIds.has(id));
    if (unknown.length)
      throw new Error(`"${label}" refers to an accompaniment that does not exist`);
    const max = Number(group?.max ?? options.length);
    const min = Number(group?.min ?? 0);
    if (!Number.isInteger(max) || max < 1 || max > options.length)
      throw new Error(`"${label}": "pick at most" must be between 1 and ${options.length}`);
    if (!Number.isInteger(min) || min < 0 || min > max)
      throw new Error(`"${label}": "pick at least" must be between 0 and ${max}`);
    return { label, options, min, max };
  });
}

// Keeps only accompaniments that can be served right now, and relaxes the
// limits to what is left (a required group whose options are all sold out no
// longer blocks the dish). Groups with nothing left are dropped.
function availableGroups(groups, isAvailable) {
  return (groups || [])
    .map((group) => {
      const options = group.options.filter((id) => isAvailable(id));
      return {
        label: group.label,
        options,
        min: Math.min(group.min, options.length),
        max: Math.min(group.max, options.length),
      };
    })
    .filter((group) => group.options.length > 0);
}

// Checks a selection against (available) groups. Returns an error message,
// or '' when the selection is valid.
function selectionError(groups, selectedIds) {
  const selected = (selectedIds || []).map(String);
  if (new Set(selected).size !== selected.length) return 'The same accompaniment was chosen twice';
  const counts = groups.map(() => 0);
  for (const id of selected) {
    const index = groups.findIndex((group) => group.options.includes(id));
    if (index === -1) return 'An accompaniment is not available for this dish';
    counts[index] += 1;
  }
  for (const [index, group] of groups.entries()) {
    if (counts[index] > group.max)
      return group.max === 1
        ? `Choose only one ${group.label.toLowerCase()} option`
        : `Choose at most ${group.max} from ${group.label}`;
    if (counts[index] < group.min) return `Choose at least ${group.min} from ${group.label}`;
  }
  return '';
}

module.exports = { normalizeGroups, availableGroups, selectionError };
