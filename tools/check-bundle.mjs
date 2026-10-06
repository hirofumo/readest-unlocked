#!/usr/bin/env node
/**
 * Proves the unlock patch reached the built frontend bundle.
 *
 * tools/verify.mjs checks the sources; this checks the artifact `next build`
 * produced. It is the difference between "we edited the right file" and "the
 * shipped app is actually unlocked".
 *
 * Usage:
 *   node tools/check-bundle.mjs [--root <path-to-readest-checkout>]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const NEEDLE = '__READEST_UNLOCKED__';

const parseRoot = () => {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const value = process.argv[i + 1];
    if (!value) {
      console.error('[check-bundle] ERROR: --root requires a path');
      process.exit(1);
    }
    return path.resolve(value);
  }
  return path.resolve(process.env['READEST_ROOT'] ?? process.cwd());
};

/** Every file under `dir` whose name ends with one of `exts`. */
function walk(dir, exts) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) found.push(...walk(full, exts));
    else if (exts.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

const root = parseRoot();
const outDir = path.join(root, 'apps', 'readest-app', 'out');

if (!existsSync(outDir)) {
  console.error(
    `[check-bundle] ERROR: ${outDir} does not exist.\n` +
      '  Run the frontend build (`pnpm --filter @readest/readest-app build`) first.',
  );
  process.exit(1);
}

// `out/_next/static/chunks` is where the app code lands; fall back to the whole
// export tree so a layout change upstream does not silently skip the check.
const chunkDir = path.join(outDir, '_next', 'static', 'chunks');
const searchDir = existsSync(chunkDir) ? chunkDir : path.join(outDir, '_next');
const files = walk(searchDir, ['.js', '.mjs']);

if (files.length === 0) {
  console.error(`[check-bundle] ERROR: no JS files found under ${searchDir}`);
  process.exit(1);
}

const matches = [];
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (content.includes(NEEDLE)) matches.push(path.relative(root, file));
}

console.log(`[check-bundle] scanned ${files.length} JS file(s) under ${path.relative(root, searchDir)}`);

if (matches.length === 0) {
  console.error(
    `\n[check-bundle] FAILED: ${NEEDLE} was not found in the built bundle.\n` +
      '  The patch did not reach the artifact. Do not ship this build.',
  );
  process.exit(1);
}

console.log(`[check-bundle] ${NEEDLE} found in ${matches.length} chunk(s):`);
for (const file of matches.slice(0, 5)) console.log(`  ${file}`);
if (matches.length > 5) console.log(`  ... and ${matches.length - 5} more`);
console.log('\n[check-bundle] the built bundle is unlocked');
