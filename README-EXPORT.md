# delivery-ledger

Your app, exported from Back4App on 2026-09-25.

This is a React + Vite project. `src/` is the app, `cloud/` is your Cloud
Code, and `public/` holds your static assets.

## Running it

You need Node 20.

    npm install
    npm run dev

## Connecting it to Parse

The app talks to Parse Server through `/parse`, which `vite.config.ts`
proxies to `http://localhost:1337`. That is where Parse ran inside your
Back4App workspace; on your machine nothing answers there yet, so point the
proxy at a Parse Server of your own — a local one, or the Back4App app this
project is published to.

Two places carry that address:

- `vite.config.ts` → `server.proxy['/parse'].target`
- `src/parse.ts` → the app id passed to `Parse.initialize`. It falls back to
  `sandbox-app-id`, which is what the workspace's Parse used; a different
  server means a different app id. Set `VITE_PARSE_APP_ID` instead of editing
  the file — see `.env.local.example`.

If hot reload doesn't connect, drop the `server.hmr` block from
`vite.config.ts`: it is pinned to `wss` on port 443 for the hosted preview,
which is not how you're serving it locally.

## What is NOT in this archive

- `node_modules` — that is what `npm install` is for.
- Your database contents and any files uploaded through Parse.
- `.env.local`, written by the platform. Any API keys you gave the agent live
  outside this project; set them again in your own environment.
