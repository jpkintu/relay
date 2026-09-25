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

// LiveQuery is not used yet (screens poll). Only configure it when explicitly
// set, or when Parse is served from this origin (local development).
if (env.VITE_PARSE_LIVEQUERY_URL) {
  Parse.liveQueryServerURL = env.VITE_PARSE_LIVEQUERY_URL;
} else if (typeof window !== 'undefined' && Parse.serverURL.startsWith('/')) {
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  Parse.liveQueryServerURL = `${wsProto}//${window.location.host}${Parse.serverURL}`;
}

export default Parse;
