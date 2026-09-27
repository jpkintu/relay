import Parse from 'parse';

// Where the Parse backend lives. All three values are baked in at build time.
//
// Production (Back4App Parse app): set on the frontend deployment
//   VITE_PARSE_SERVER_URL = https://parseapi.back4app.com
//   VITE_PARSE_APP_ID     = <Application ID>
//   VITE_PARSE_JS_KEY     = <JavaScript key>
// (Back4App dashboard → App Settings → Security & Keys.) These are client keys:
// they end up in the browser bundle by design; access control is enforced by
// Cloud Code, ACLs and CLPs, never by keeping them secret.
//
// Local development: leave them unset. The client talks to '/parse', which
// vite.config.ts proxies to a local Parse Server using app id 'sandbox-app-id'.
const env = import.meta.env;
Parse.initialize(env.VITE_PARSE_APP_ID || 'sandbox-app-id', env.VITE_PARSE_JS_KEY || '');
Parse.serverURL = env.VITE_PARSE_SERVER_URL || '/parse';

// LiveQuery (live updates, src/lib/live.ts). On Back4App: Server Settings →
// Web Hosting and Live Query → turn on Live Query for Order, CashHandover and
// Notification, and set VITE_PARSE_LIVEQUERY_URL = wss://<subdomain>.b4a.io.
// Without it the screens poll every 10 s, as before. Local development uses
// the Parse Server on this origin.
if (env.VITE_PARSE_LIVEQUERY_URL) {
  Parse.liveQueryServerURL = env.VITE_PARSE_LIVEQUERY_URL;
} else if (typeof window !== 'undefined' && Parse.serverURL.startsWith('/')) {
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  Parse.liveQueryServerURL = `${wsProto}//${window.location.host}${Parse.serverURL}`;
}

// A database error can arrive with an object as its message (e.g. Postgres
// details); screens show `error.message` as text, so make it readable.
const runCloud = Parse.Cloud.run.bind(Parse.Cloud);
Parse.Cloud.run = (async (...args: Parameters<typeof runCloud>) => {
  try {
    return await runCloud(...args);
  } catch (error) {
    if (error && typeof (error as { message?: unknown }).message !== 'string')
      (error as { message: string }).message =
        'The server could not complete this. Try again; if it keeps happening, ask the owner to run Apply security rules.';
    throw error;
  }
}) as typeof Parse.Cloud.run;

export const LIVE_ENABLED = Boolean(
  env.VITE_PARSE_LIVEQUERY_URL ||
  (typeof window !== 'undefined' && Parse.serverURL.startsWith('/')),
);

export default Parse;
