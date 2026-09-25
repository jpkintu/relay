import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './parse'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          padding: '24px',
          background: '#1a1a1a',
          color: '#ff6b6b',
          minHeight: '100vh',
          whiteSpace: 'pre-wrap',
          fontSize: '13px',
          lineHeight: 1.5,
        }}>
          <div style={{ color: '#f87171', fontWeight: 700, fontSize: '15px', marginBottom: '12px' }}>
            Runtime error in your React app:
          </div>
          <div style={{ color: '#fca5a5' }}>{this.state.error.message}</div>
          <div style={{ color: '#9ca3af', marginTop: '12px', fontSize: '11px' }}>
            {this.state.error.stack}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Global runtime error capture — shows ANYTHING that crashes during mount
window.addEventListener('error', (e) => {
  const root = document.getElementById('root')
  if (root && !root.innerHTML.trim()) {
    root.innerHTML = `<div style="font-family:ui-monospace,monospace;padding:24px;background:#1a1a1a;color:#ff6b6b;min-height:100vh;white-space:pre-wrap;font-size:13px"><strong style="color:#f87171;font-size:15px">Window error:</strong>\n${e.message}\n\n${e.filename}:${e.lineno}:${e.colno}</div>`
  }
})

try {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
} catch (err: any) {
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `<div style="font-family:ui-monospace,monospace;padding:24px;background:#1a1a1a;color:#ff6b6b;min-height:100vh;white-space:pre-wrap;font-size:13px"><strong style="color:#f87171;font-size:15px">Mount error:</strong>\n${err?.message || err}\n\n${err?.stack || ''}</div>`
  }
}
