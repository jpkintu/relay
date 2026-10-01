// Relay Hosted: which restaurant this device signs in to. The restaurant's own
// address sets it: its subdomain (aldea.relayeats.app, when platform staff set
// the restaurant domain) or /r/<code>. Otherwise it is remembered on the
// device, so staff only type their username and PIN afterwards.

const KEY = 'relay.restaurant';
const CODE = /^[a-z0-9-]{3,30}$/;

export function normaliseCode(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// The platform's restaurant domain (e.g. relayeats.app), remembered from the
// server's app info so a subdomain is recognised from the first moment.
const DOMAIN_KEY = 'relay.domain';
// Subdomains that are not restaurants.
const NOT_RESTAURANTS = new Set(['www', 'app', 'api', 'admin', 'platform', 'mail', 'help']);

export function knownDomain(): string {
  try {
    return localStorage.getItem(DOMAIN_KEY) || import.meta.env.VITE_RESTAURANT_DOMAIN || '';
  } catch {
    return import.meta.env.VITE_RESTAURANT_DOMAIN || '';
  }
}
export function rememberDomain(domain: string) {
  try {
    if (domain) localStorage.setItem(DOMAIN_KEY, domain);
    else localStorage.removeItem(DOMAIN_KEY);
  } catch {
    // Private mode: recognised once the app info arrives.
  }
}

// The restaurant code in a host such as aldea.relayeats.app ('' if none).
export function subdomainCode(domain: string, host: string): string {
  const root = domain.trim().toLowerCase();
  const name = host.trim().toLowerCase();
  if (!root || !name.endsWith(`.${root}`)) return '';
  const sub = name.slice(0, -(root.length + 1));
  return !sub.includes('.') && CODE.test(sub) && !NOT_RESTAURANTS.has(sub) ? sub : '';
}
export const hostCode = (domain = knownDomain()) =>
  typeof window === 'undefined' ? '' : subdomainCode(domain, window.location.hostname);

// How a restaurant's address reads: its subdomain, or /r/<code>.
export const restaurantAddress = (code: string, domain: string) =>
  domain ? `${code}.${domain}` : `/r/${code}`;

// Reads /r/<code> once (then shows the plain address), else the subdomain,
// else the remembered one.
export function restaurantCode(): string {
  const fromHost = hostCode();
  if (fromHost) {
    rememberRestaurant(fromHost);
    return fromHost;
  }
  const match = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (match) {
    const code = normaliseCode(decodeURIComponent(match[1]));
    if (CODE.test(code)) {
      rememberRestaurant(code);
      window.history.replaceState(null, '', '/');
      return code;
    }
  }
  return savedRestaurant();
}

export function savedRestaurant(): string {
  try {
    const saved = localStorage.getItem(KEY) || '';
    return CODE.test(saved) ? saved : '';
  } catch {
    return '';
  }
}

export function rememberRestaurant(code: string) {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the code is typed again next time.
  }
}

// Usernames are stored as name@restaurant-code on the server.
export const signInName = (username: string, code: string) =>
  username.includes('@') || !code ? username : `${username}@${code}`;
