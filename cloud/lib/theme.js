// Restaurant theme colours (Branding): the dark main colour (sidebar,
// headers, primary buttons and text) and the accent (highlights and
// secondary buttons). Colours are checked for contrast so text stays
// readable whatever the owner picks. src/lib/theme.ts mirrors these rules.

const DEFAULT_THEME = { ink: '#0b1633', accent: '#f14c1d' };
const CREAM = '#f4f6fb';
const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// '' means "use Relay's default". Returns a list of problems (empty = fine).
function themeProblems({ ink = '', accent = '' }) {
  const problems = [];
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

// The stored values, lower case, '' for defaults.
function cleanTheme(params) {
  const tidy = (value) =>
    String(value || '')
      .trim()
      .toLowerCase();
  return { ink: tidy(params.ink), accent: tidy(params.accent) };
}

module.exports = { DEFAULT_THEME, themeProblems, cleanTheme, contrast };
