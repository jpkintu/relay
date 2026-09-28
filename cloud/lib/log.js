// Structured Cloud Code logs: one JSON object per line, so Back4App's log
// viewer (and any log tool) can search by event, function or user.
//   log('error', 'function.failed', { fn: 'createOrder', user: 'abc', ms: 120 })

function log(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// A readable message from anything thrown (Postgres errors carry an object).
function errorMessage(error) {
  const message = error?.message;
  if (message && typeof message === 'object')
    return String(message.message || JSON.stringify(message));
  return String(message || error || 'Unknown error');
}

// Errors the app raises on purpose (wrong PIN, missing field, no permission)
// are Parse errors with their own code. Anything else (a TypeError, a
// database failure, a crashed dependency) is a bug worth recording.
const UNEXPECTED_PARSE_CODES = [-1, 1, 100];
function isUnexpected(error) {
  if (!error || typeof error.code !== 'number') return true;
  return UNEXPECTED_PARSE_CODES.includes(error.code);
}

module.exports = { log, errorMessage, isUnexpected };
