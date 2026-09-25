import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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
