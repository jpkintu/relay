/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Parse Application ID. Unset locally → 'sandbox-app-id'. */
  readonly VITE_PARSE_APP_ID?: string;
  /** Parse JavaScript key (Back4App requires it). */
  readonly VITE_PARSE_JS_KEY?: string;
  /** Parse server URL, e.g. https://parseapi.back4app.com. Unset → '/parse'. */
  readonly VITE_PARSE_SERVER_URL?: string;
  /** Optional LiveQuery WebSocket URL, e.g. wss://<subdomain>.b4a.io. */
  readonly VITE_PARSE_LIVEQUERY_URL?: string;
  /** 'true' shows the demo preview mode (the server must also allow it). */
  readonly VITE_ENABLE_PREVIEW?: string;
  /** Back4App managed Google sign-in proxy, if used. */
  readonly VITE_BACK4APP_OAUTH_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
