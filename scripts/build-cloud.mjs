// Bundles cloud/ into a single file for Back4App, whose Cloud Code page takes
// uploaded files rather than a GitHub folder. Output: back4app/cloud/main.js.
// Run `npm run build:cloud` after changing anything in cloud/ and commit the
// result; CI fails if the committed bundle is out of date.
import { build } from 'esbuild';

await build({
  entryPoints: ['cloud/main.js'],
  outfile: 'back4app/cloud/main.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  legalComments: 'none',
  banner: {
    js: [
      '// Relay, designed and developed by Embiro Concepts. See NOTICE.',
      '// GENERATED FILE: do not edit. Source: cloud/ in the Relay repository.',
      '// Rebuild with `npm run build:cloud`. Upload this single file as the',
      "// Back4App app's Cloud Code main.js (see docs/ROADMAP.md §2).",
    ].join('\n'),
  },
});
console.log('Wrote back4app/cloud/main.js');
