import Parse from 'parse'

// App id is injected at promote build time via VITE_PARSE_APP_ID so the
// published client matches the per-app id the production Parse Server runs
// with (PARSE_APP_ID). In the sandbox dev build the var is unset and we
// fall back to 'sandbox-app-id', which the sandbox dev server also uses.
Parse.initialize(import.meta.env.VITE_PARSE_APP_ID || 'sandbox-app-id', '')
Parse.serverURL = '/parse'

// LiveQuery needs an ABSOLUTE ws/wss URL. The preview runs in PATH MODE (api
// proxy at /agents/<id>/preview), where the injected bootstrap exposes the
// parse proxy MOUNT as __BACK4APP_PARSE_BASE__ (e.g. /agents/<id>/parse). The
// WS MUST use that — a bare '/parse' would NOT be routed by the api (it only
// forwards /agents/<id>/parse). Fall back to '/parse' for the direct sandbox
// tunnel and the published app (own domain, where Vite/nginx proxy it).
if (typeof window !== 'undefined') {
  const base =
    (window as unknown as { __BACK4APP_PARSE_BASE__?: string })
      .__BACK4APP_PARSE_BASE__ || '/parse'
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  Parse.liveQueryServerURL = `${wsProto}//${window.location.host}${base}`
}

export default Parse
