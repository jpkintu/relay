/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Per-app Parse application id, injected at promote build time by the
   * worker (sandboxBuildImages → VITE_PARSE_APP_ID = app.id). Unset in the
   * sandbox dev build, where the client falls back to 'sandbox-app-id'.
   */
  readonly VITE_PARSE_APP_ID?: string;
  readonly VITE_PARSE_SERVER_URL?: string;
  /**
   * Absolute base URL of the platform's managed-OAuth proxy (the containers
   * API), baked at promote build time. Unset in the sandbox dev build, where
   * the preview shares the API's origin and relative paths work.
   */
  readonly VITE_BACK4APP_OAUTH_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
