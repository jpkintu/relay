// Restaurant theme colours (Admin → Branding). Mirrors cloud/lib/theme.js,
// which has the final say; this copy gives instant feedback and applies the
// colours to the page. The favicon and installed-app icon stay Relay's.

export type Theme = { ink: string; accent: string };

export const DEFAULT_THEME: Theme = { ink: '#0b1633', accent: '#f14c1d' };
const CREAM = '#f4f6fb';
const HEX = /^#[0-9a-f]{6}$/i;
const STORE = 'relay.theme';

function luminance(hex: string) {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// '' means "use Relay's default". Returns the problems (empty = fine).
export function themeProblems({ ink = '', accent = '' }: Partial<Theme>) {
  const problems: string[] = [];
  for (const [label, value] of [
    ['Main colour', ink],
    ['Accent colour', accent],
  ])
    if (value && !HEX.test(value)) problems.push(`${label} must look like #1a2b3c`);
  if (problems.length) return problems;
  const main = ink || DEFAULT_THEME.ink;
  const highlight = accent || DEFAULT_THEME.accent;
  if (contrast(main, CREAM) < 7)
    problems.push('Main colour is too light: text in it would be hard to read. Pick a darker one');
  else if (contrast(highlight, main) < 3)
    problems.push('Accent colour is too close to the main colour. Pick a brighter one');
  return problems;
}

// Sets the colours on the page (and remembers them, so the next start does
// not flash Relay's colours first). Invalid or blank values fall back.
export function applyTheme(theme?: Partial<Theme> | null) {
  const ink = theme?.ink || '';
  const accent = theme?.accent || '';
  const ok = !themeProblems({ ink, accent }).length;
  const root = document.documentElement.style;
  if (ok && ink) {
    root.setProperty('--ink', ink);
    // A lighter shade of the main colour for raised panels on it.
    root.setProperty('--ink-raised', `color-mix(in srgb, ${ink} 72%, white)`);
    root.setProperty('--ink-card', `color-mix(in srgb, ${ink} 80%, white)`);
    // Links, unread dots and info tints take the main colour too.
    root.setProperty('--blue', ink);
  } else {
    root.removeProperty('--ink');
    root.removeProperty('--ink-raised');
    root.removeProperty('--ink-card');
    root.removeProperty('--blue');
  }
  if (ok && accent) root.setProperty('--accent', accent);
  else root.removeProperty('--accent');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', (ok && ink) || DEFAULT_THEME.ink);
  try {
    if (ok && (ink || accent)) localStorage.setItem(STORE, JSON.stringify({ ink, accent }));
    else localStorage.removeItem(STORE);
  } catch {
    // Private mode: the colours still apply for this visit.
  }
}

// On start: the colours saved last time, until the server answers.
export function applyStoredTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) applyTheme(saved);
  } catch {
    // ignore
  }
}
