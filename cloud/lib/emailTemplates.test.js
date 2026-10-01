import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { KINDS, SAMPLE, render, forBrevo, dateText, moneyText } from './emailTemplates.js';
import { files } from '../../scripts/email-templates.mjs';

const placeholders = (text) =>
  [...text.matchAll(/\{\{\{\s*([A-Z0-9_]+)\s*\}\}\}/g)].map((match) => match[1]);

describe('email templates', () => {
  test('every placeholder is a declared variable, and every variable is used', () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
      const used = new Set([
        ...placeholders(spec.subject),
        ...placeholders(spec.html),
        ...placeholders(spec.text),
      ]);
      for (const name of used) expect(spec.variables, `${kind} ${name}`).toContain(name);
      for (const name of spec.variables)
        if (name !== 'DAYS_LEFT' && name !== 'DAYS_TO_CLOSE')
          expect(used.has(name), `${kind} uses ${name}`).toBe(true);
      for (const name of spec.variables) expect(SAMPLE[name], `sample ${name}`).toBeDefined();
    }
  });

  test('rendering fills every variable and escapes the HTML', () => {
    const out = render('welcome', { ...SAMPLE, RESTAURANT_NAME: 'Rose & <Co>' });
    expect(out.subject).toBe('Welcome to Relay, Rose & <Co>');
    expect(out.html).toContain('Rose &amp; &lt;Co&gt;');
    expect(out.html).not.toMatch(/\{\{\{/);
    expect(out.text).toContain('Restaurant code: kampala-grill-house');
    expect(Object.keys(out.variables).sort()).toEqual([...KINDS.welcome.variables].sort());
  });

  test('Brevo gets {{ params.X }}', () => {
    expect(forBrevo('Hi {{{OWNER_NAME}}}')).toBe('Hi {{ params.OWNER_NAME }}');
  });

  test('dates and money read naturally', () => {
    expect(dateText(new Date('2026-10-15T21:30:00Z'))).toBe('16 October 2026');
    expect(moneyText(1000000, 'UGX')).toBe('UGX 1,000,000');
  });

  test('docs/email-templates is up to date', () => {
    for (const [name, content] of Object.entries(files()))
      expect(readFileSync(`docs/email-templates/${name}`, 'utf8'), name).toBe(content);
  });
});
