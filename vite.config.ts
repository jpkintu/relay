import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// `vite preview` (how the Container serves the site) sends every file with
// "Cache-Control: no-cache", so a phone asks the server about each script on
// every visit, a round trip each on a slow network. Files under /assets have
// the content hash in their name and never change: let browsers keep them.
// The page and the service worker keep no-cache so a deploy is seen at once.
const longCacheAssets = {
  name: 'relay-long-cache-assets',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/assets/')) {
        // sirv sets its own Cache-Control when it writes the head; replace it.
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...rest) => {
          // Only a file that exists; a missing one (an old deploy) is not kept.
          if (status === 200 || status === 304) {
            for (const arg of rest)
              if (arg && typeof arg === 'object')
                for (const key of Object.keys(arg))
                  if (key.toLowerCase() === 'cache-control') delete arg[key];
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
          return writeHead(status, ...rest);
        };
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), longCacheAssets],
  // The build date, sent with crash reports (src/lib/errors.ts) so the owner
  // can tell an old copy of the app from the current one.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(
      process.env.VITE_APP_VERSION || new Date().toISOString().slice(0, 16).replace('T', ' '),
    ),
  },
  resolve: {
    // Force ONE copy of React. If a mid-session dep re-optimize (below) ever
    // slips through, deduping keeps the app and react-dom on the same React
    // instance, so the hooks dispatcher can't be null
    // ("Cannot read properties of null (reading 'useState')").
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    // Pre-bundle everything the pre-installed UI kit imports at RUNTIME, so Vite
    // does a SINGLE optimize pass at server start instead of discovering these
    // deps as the generated app first imports them and re-optimizing mid-load.
    // A mid-load re-optimize hands out chunks from two passes (different `?v=`
    // hashes) — the app gets React from one and react-dom from the other, and
    // the app white-screens with a null hooks dispatcher. Keep in sync with the
    // runtime deps in package.json (build-only tools like tailwind plugins are
    // intentionally omitted).
    include: [
      'parse',
      'events',
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react-router-dom',
      'react-hook-form',
      '@hookform/resolvers',
      'zod',
      '@tanstack/react-query',
      '@tanstack/react-table',
      'framer-motion',
      'lucide-react',
      'recharts',
      'sonner',
      'date-fns',
      'embla-carousel-react',
      'next-themes',
      'cmdk',
      'vaul',
      'input-otp',
      'react-day-picker',
      'react-resizable-panels',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      '@radix-ui/react-accordion',
      '@radix-ui/react-alert-dialog',
      '@radix-ui/react-aspect-ratio',
      '@radix-ui/react-avatar',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-collapsible',
      '@radix-ui/react-context-menu',
      '@radix-ui/react-dialog',
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-hover-card',
      '@radix-ui/react-label',
      '@radix-ui/react-menubar',
      '@radix-ui/react-navigation-menu',
      '@radix-ui/react-popover',
      '@radix-ui/react-progress',
      '@radix-ui/react-radio-group',
      '@radix-ui/react-scroll-area',
      '@radix-ui/react-select',
      '@radix-ui/react-separator',
      '@radix-ui/react-slider',
      '@radix-ui/react-slot',
      '@radix-ui/react-switch',
      '@radix-ui/react-tabs',
      '@radix-ui/react-toast',
      '@radix-ui/react-toggle',
      '@radix-ui/react-toggle-group',
      '@radix-ui/react-tooltip',
    ],
  },
  // Credit comment kept at the top of every built JavaScript file.
  build: {
    // Embed the small Embiro logo in the JS so the credit shows at once,
    // even on the first loading screen; other assets use the default rule.
    assetsInlineLimit: (file) => (file.endsWith('embiro-logo-small.webp') ? true : undefined),
    rollupOptions: {
      output: {
        banner: '/*! Relay, designed and developed by Embiro Concepts. See NOTICE. */',
        // Parse, React and the router in a file of their own: its name only
        // changes when a library is upgraded, so phones keep it (service
        // worker cache) across Relay deploys instead of downloading ~400 kB
        // again. The chart and map libraries stay separate, loaded on use.
        manualChunks: (id) =>
          /node_modules\/(parse|react|react-dom|react-router|react-router-dom|@remix-run|scheduler|core-js-pure|@babel\/runtime-corejs3|crypto-js|events|idb-keyval)\//.test(
            id,
          )
            ? 'vendor'
            : undefined,
      },
    },
  },
  // `npm run preview` is how Back4App Containers serves the built site. Accept
  // any host name (the b4a.run URL, custom domains); it only serves static files.
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app', '.e2b.dev', 'localhost'],
    hmr: {
      protocol: 'wss',
      clientPort: 443,
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
    proxy: {
      '/parse': {
        target: 'http://localhost:1337',
        changeOrigin: true,
        // Forward LiveQuery WebSocket upgrades (Parse.liveQueryServerURL =
        // wss://<host>/parse) to the Parse LiveQuery server on :1337.
        ws: true,
      },
    },
  },
});
