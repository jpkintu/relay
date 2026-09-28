// Relay Hosted: which restaurant this device signs in to. The restaurant's own
// address (/r/<code>) sets it; it is remembered on the device so staff only
// type their username and PIN afterwards.

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

// Reads /r/<code> once (then shows the plain address), else the remembered one.
export function restaurantCode(): string {
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
