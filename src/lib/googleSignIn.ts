import Parse from '../parse'

// "Managed by Back4app" Google Sign-In (docs/managed-google-signin.md in the
// platform repo). The OAuth dance runs on the platform's fixed public host —
// this app never talks to Google directly and needs zero Google Cloud
// Console configuration:
//
//   1. startGoogleSignIn() opens the platform's authorize endpoint, which
//      validates this app and redirects to Google.
//   2. Google consent → platform callback verifies the identity and mints a
//      Parse session scoped to THIS app → returns with `#session_token=...`
//      in the URL fragment (the Google id_token never reaches the browser,
//      so it can't be replayed at another app).
//   3. completeGoogleSignIn() (call it on page load) adopts the session
//      (Parse.User.become) and returns the logged-in user.
//
// Two runtime modes, chosen automatically:
//   - Top-level page (published app, or preview opened in its own tab):
//     full-page navigation; the result comes back in this page's fragment.
//   - Inside an iframe (e.g. the Back4App dashboard preview): Google refuses
//     to render its consent page in a frame (X-Frame-Options), so the flow
//     runs in a POPUP and the result is delivered back via postMessage.
// The app code is identical in both cases:
//
//   useEffect(() => {
//     completeGoogleSignIn().then((user) => user && onLoggedIn(user))
//   }, [])
//   ...
//   <button onClick={() => startGoogleSignIn()}>Sign in with Google</button>

// Where the platform's OAuth proxy lives. Published build: baked absolute
// URL via VITE_BACK4APP_OAUTH_PROXY_URL (the app runs on its own domain,
// the proxy does not). Sandbox dev build: the var is unset and the preview
// is served through the platform API's own origin, so same-origin relative
// paths reach the proxy directly.
const OAUTH_PROXY_BASE = (
  import.meta.env.VITE_BACK4APP_OAUTH_PROXY_URL || ''
).replace(/\/+$/, '')

const AUTHORIZE_PATH = '/oauth-auth/google/authorize'
const POPUP_MESSAGE_TYPE = 'back4app-google-signin'
const POPUP_NAME = 'back4app_google_signin'

function inIframe(): boolean {
  try {
    return window.self !== window.top
  } catch {
    // Cross-origin access to window.top throws → we ARE framed.
    return true
  }
}

function buildAuthorizeUrl(options?: {
  redirectPath?: string
  echo?: string
}): string {
  // The redirect must land back on THIS app's preview surface, so the OAuth
  // result reloads the app (running completeGoogleSignIn) AND passes the
  // platform's redirect-ownership check. In the dashboard's PATH-based preview
  // the platform resets window.location to "/" (so BrowserRouter works without
  // a basename) — window.location.pathname is therefore NOT the app's real
  // mount. The preview proxy injects the true base as __BACK4APP_PREVIEW_BASE__
  // (e.g. "/agents/<id>/preview"); prepend it. In subdomain preview / a
  // published app the base is empty and the app owns its origin root, so this
  // collapses to the previous origin + pathname behavior.
  const previewBase = (
    (window as unknown as { __BACK4APP_PREVIEW_BASE__?: string })
      .__BACK4APP_PREVIEW_BASE__ || ''
  ).replace(/\/+$/, '')
  const path = options?.redirectPath ?? (previewBase ? '/' : window.location.pathname)
  const redirectUri =
    window.location.origin +
    previewBase +
    (path.startsWith('/') ? path : '/' + path)

  const url = new URL(OAUTH_PROXY_BASE + AUTHORIZE_PATH, window.location.origin)
  url.searchParams.set('appId', Parse.applicationId)
  url.searchParams.set('redirectUri', redirectUri)
  if (options?.echo) url.searchParams.set('echo', options.echo)
  return url.toString()
}

/**
 * Start a managed Google sign-in. Inside an iframe it opens a popup (Google
 * won't render inside a frame); otherwise it navigates the page. The result
 * is handled by completeGoogleSignIn() — no extra wiring needed.
 *
 * @param options.redirectPath page to come back to with the result
 *   (same-origin path, e.g. '/login'); defaults to the current page.
 * @param options.echo opaque value returned verbatim as `state` in the result.
 */
export function startGoogleSignIn(options?: {
  redirectPath?: string
  echo?: string
}): void {
  const authorizeUrl = buildAuthorizeUrl(options)

  if (inIframe()) {
    const w = 480
    const h = 640
    // Center over the current screen for a native feel.
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2)
    // A user-gesture window.open is not caught by popup blockers. NOTE: a
    // sandboxed iframe often returns `null` here EVEN WHEN the popup opened
    // (it gets no cross-origin handle), so we must NOT treat null as
    // "blocked" and navigate as a fallback — that would send the iframe
    // itself to Google, which refuses to render in a frame (the 403 page).
    window.open(
      authorizeUrl,
      POPUP_NAME,
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    )
    return
  }

  window.location.assign(authorizeUrl)
}

export class GoogleSignInError extends Error {
  constructor(public readonly code: string) {
    super(`Google sign-in failed: ${code}`)
  }
}

function readResultFromFragment(): {
  sessionToken: string | null
  error: string | null
  present: boolean
} {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const sessionToken = params.get('session_token')
  const error = params.get('error')
  return { sessionToken, error, present: !!(sessionToken || error) }
}

function clearFragment(): void {
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search
  )
}

/**
 * Complete a sign-in started by startGoogleSignIn(). Call it on page load.
 *
 * Returns the logged-in Parse.User on success, null when there's nothing to
 * complete, and throws GoogleSignInError if the user cancelled / it failed.
 *
 * Handles all three landings automatically:
 *   - This window is the popup that finished the dance → hand the result to
 *     the opener via postMessage and close (returns null; never logs in here).
 *   - Top-level redirect returned with the result in the fragment → adopt it.
 *   - Running in an iframe with no fragment → resolve null immediately (it must
 *     never block the initial render), and register a listener that adopts a
 *     later popup result and reloads; completeGoogleSignIn() then returns the
 *     signed-in user on the fresh mount, for both `await` and `.then` callers.
 */
export async function completeGoogleSignIn(): Promise<Parse.User | null> {
  const fromFragment = readResultFromFragment()
  const isPopup = (() => {
    try {
      return !!window.opener && window.opener !== window.self
    } catch {
      return false
    }
  })()

  // Case 1 — we ARE the popup that just finished. Hand the result to the
  // opener (same-origin: the app that opened us) and close. Never adopt the
  // session inside the popup.
  if (fromFragment.present && isPopup) {
    clearFragment()
    try {
      window.opener?.postMessage(
        {
          type: POPUP_MESSAGE_TYPE,
          session_token: fromFragment.sessionToken,
          error: fromFragment.error,
        },
        window.location.origin
      )
    } catch {
      /* opener gone — nothing we can do */
    }
    window.close()
    return null
  }

  // Case 2 — top-level redirect landed back here with the result. Adopt it.
  if (fromFragment.present) {
    clearFragment()
    if (fromFragment.error) throw new GoogleSignInError(fromFragment.error)
    return await adoptSession(fromFragment.sessionToken!)
  }

  // Case 3a — top-level page with no result: sign-in comes back via full-page
  // redirect (Case 2 on the next load), so there's nothing to wait for.
  if (!inIframe()) return null

  // Case 3b — framed page, no result in our URL yet.
  //
  // Do NOT wait for the popup here. On a normal load there may be no sign-in
  // happening at all, and callers that `await completeGoogleSignIn()` before
  // rendering (a common generated-app pattern: `setLoading(false)` in a
  // `finally`) would hang forever on the returned promise — the app gets stuck
  // on its loading screen.
  //
  // Instead: if we JUST completed a sign-in (the flag was set right before we
  // reloaded ourselves, below), return the now-active user so BOTH `await` and
  // `.then` callers receive it on this fresh mount. Otherwise register a
  // one-time listener that adopts a LATER popup result, persists the session,
  // sets the flag and reloads — and resolve null NOW so nothing blocks.
  const JUST_SIGNED_IN_KEY = 'b4a_gsi_completed'
  try {
    if (window.sessionStorage.getItem(JUST_SIGNED_IN_KEY)) {
      window.sessionStorage.removeItem(JUST_SIGNED_IN_KEY)
      return Parse.User.current() ?? null
    }
  } catch {
    /* sessionStorage unavailable — fall through to the listener */
  }

  const onMessage = async (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return
    const data = event.data as {
      type?: string
      session_token?: string | null
      error?: string | null
    } | null
    if (!data || data.type !== POPUP_MESSAGE_TYPE) return
    window.removeEventListener('message', onMessage)
    // A cancelled / failed sign-in leaves the app exactly as it was.
    if (data.error || !data.session_token) return
    try {
      await adoptSession(data.session_token)
      try {
        window.sessionStorage.setItem(JUST_SIGNED_IN_KEY, '1')
      } catch {
        /* ignore */
      }
      // Re-mount with the active session. completeGoogleSignIn() returns the
      // user above on the fresh load, so app auth state updates with no extra
      // wiring — and it never blocks the initial render.
      window.location.reload()
    } catch {
      /* adoption failed — leave the app as-is */
    }
  }
  window.addEventListener('message', onMessage)
  return null
}

// The platform verified the Google identity server-side and minted this
// sessionToken against THIS app's own Parse (via loginAs). It is app-scoped
// and revocable — the raw Google id_token never reaches the browser, so it
// can't be replayed at another app that shares the platform Google client.
async function adoptSession(sessionToken: string): Promise<Parse.User> {
  return await Parse.User.become(sessionToken)
}
