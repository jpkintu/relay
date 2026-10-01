// Writes docs/email-templates/: each email's HTML, ready to upload or paste
// into a Resend template (and Brevo's version), from cloud/lib/emailTemplates.js.
//   node scripts/email-templates.mjs           write the files
//   node scripts/email-templates.mjs --check   fail when they are out of date
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { KINDS, forBrevo } = createRequire(import.meta.url)(
  join(root, 'cloud/lib/emailTemplates.js'),
);

export function files() {
  const out = {};
  for (const [kind, spec] of Object.entries(KINDS)) {
    out[`resend/${kind}.html`] = spec.html;
    out[`brevo/${kind}.html`] = forBrevo(spec.html);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(root, 'docs/email-templates');
  const stale = [];
  for (const [name, content] of Object.entries(files())) {
    const path = join(dir, name);
    if (process.argv.includes('--check')) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(name);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  if (stale.length) {
    console.error(`Out of date (run npm run email:templates): ${stale.join(', ')}`);
    process.exit(1);
  }
}
