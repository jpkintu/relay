// RelayEats Hosted: restaurant addresses (aldea.relayeats.app).
//
// Back4App Containers take no wildcard domain, so this Cloudflare Worker
// answers every <code>.relayeats.app (route `*.relayeats.app/*`, DNS record
// `*` AAAA 100:: proxied) by fetching the same path from the main site,
// relayeats.app, which Back4App serves. The browser keeps the restaurant's
// address, so the app knows which restaurant it is (src/lib/restaurant.ts).
// See docs/HOSTED.md, "Restaurant addresses".
const APP = 'relayeats.app';
// Back4App's own address for the Container, never shown to visitors.
const BACK4APP = /^https?:\/\/[^/]*\.b4a\.run/i;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;
    url.hostname = APP;
    const response = await fetch(new Request(url, request), {
      redirect: 'manual',
      // Redirects are never kept by Cloudflare's cache.
      cf: { cacheTtlByStatus: { '300-399': -1 } },
    });

    const headers = new Headers(response.headers);
    const location = headers.get('location');
    if (location) {
      // A redirect stays on the restaurant's address, and browsers do not
      // keep it: an old one can never send a restaurant elsewhere again.
      headers.set(
        'location',
        location.replace(BACK4APP, `https://${host}`).replace(`//${APP}/`, `//${host}/`),
      );
      headers.set('cache-control', 'no-store');
    } else if ((headers.get('content-type') || '').includes('text/html')) {
      // The app's page is checked on every load, so a new deploy shows at once.
      headers.set('cache-control', 'no-cache');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
