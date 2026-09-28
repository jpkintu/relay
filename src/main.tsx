import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/space-grotesk';
import './index.css';
import './parse';
import { registerServiceWorker } from './lib/push';
import { listenForInstall } from './lib/install';
import { applyStoredTheme } from './lib/theme';
import { listenForErrors, reportError } from './lib/errors';

applyStoredTheme();

registerServiceWorker();
listenForInstall();
listenForErrors();

// A screen that crashes shows a plain message with a way back, and the
// error is sent to the owner's Errors page.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    const component = /at (\w+)/.exec(info.componentStack || '')?.[1];
    reportError(error, component ? `${window.location.pathname} · ${component}` : '');
  }

  render() {
    if (this.state.error) {
      return (
        <main className="crash-screen" role="alert">
          <h1>Something went wrong</h1>
          <p>
            Relay hit a problem on this screen. The owner has been sent the details. Reload to carry
            on; nothing you saved is lost.
          </p>
          <button className="primary-button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <details>
            <summary>Details</summary>
            <pre>{this.state.error.message}</pre>
          </details>
        </main>
      );
    }
    return this.props.children;
  }
}

// Global runtime error capture — shows ANYTHING that crashes during mount
window.addEventListener('error', (e) => {
  const root = document.getElementById('root');
  if (root && !root.innerHTML.trim()) {
    root.innerHTML = `<div style="font-family:ui-monospace,monospace;padding:24px;background:#1a1a1a;color:#ff6b6b;min-height:100vh;white-space:pre-wrap;font-size:13px"><strong style="color:#f87171;font-size:15px">Window error:</strong>\n${e.message}\n\n${e.filename}:${e.lineno}:${e.colno}</div>`;
  }
});

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (caught) {
  const err = caught instanceof Error ? caught : new Error(String(caught));
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div style="font-family:ui-monospace,monospace;padding:24px;background:#1a1a1a;color:#ff6b6b;min-height:100vh;white-space:pre-wrap;font-size:13px"><strong style="color:#f87171;font-size:15px">Mount error:</strong>\n${err?.message || err}\n\n${err?.stack || ''}</div>`;
  }
}
