#!/usr/bin/env node
/**
 * Builds the `SHA256SUMS` published with a release.
 *
 * GitHub stores a `sha256:<hex>` digest for every release asset and returns it
 * from the release API, so the checksums can be assembled with one API call
 * instead of downloading the ~2 GB a release weighs.
 *
 * The output follows the `shasum -a 256` convention — `<64 hex><two
 * spaces><name>` — which means it can be fed straight to `sha256sum -c` or
 * `shasum -a 256 -c` for a manual check, and to actions/attest's
 * `subject-checksums` input, which parses exactly this shape (it strips one
 * leading `*` or space as the binary/text flag).
 *
 * Usage:
 *   node tools/make-checksums.mjs --repo <owner/repo> --tag <tag> [--out SHA256SUMS]
 *
 * Reads GH_TOKEN / GITHUB_TOKEN when present to raise the rate limit.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TOKEN = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';

function fail(message) {
  console.error(`\n[checksums] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[checksums] ${message}`);
}

function warn(message) {
  console.warn(`[checksums] WARNING: ${message}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const repo = arg('repo', process.env['GITHUB_REPOSITORY'] ?? '');
const tag = arg('tag', '');
const outFile = path.resolve(arg('out', 'SHA256SUMS'));

if (!repo) fail('--repo is required (owner/repo)');
if (!tag) fail('--tag is required');

/* --------------------------------------------------------------------- fetch */

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'readest-unlocked-checksums',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
  headers,
});
if (!res.ok) {
  fail(`could not read release ${tag} of ${repo}: HTTP ${res.status} ${res.statusText}`);
}
const release = await res.json();

// One page is enough: the API returns the whole asset list for a release, and
// anything past a few hundred assets would mean the release shape changed.
const assets = release.assets ?? [];
if (assets.length === 0) fail(`release ${tag} has no assets to checksum`);

/* ---------------------------------------------------------------- checksums */

const outName = path.basename(outFile);
const missing = [];
const lines = [];

// Sorted so the file is stable: two runs over the same release produce the
// same bytes, which makes a diff of two releases readable.
for (const asset of [...assets].sort((a, b) => a.name.localeCompare(b.name))) {
  // The file cannot contain its own digest, and nothing is lost: its digest is
  // the one line a user cannot verify against a published file anyway.
  if (asset.name === outName) continue;

  const hex = String(asset.digest ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    missing.push(`${asset.name} (${asset.digest ?? 'no digest'})`);
    continue;
  }
  lines.push(`${hex}  ${asset.name}`);
}

if (missing.length) {
  warn(
    `no usable sha256 digest for ${missing.length} asset(s); they are left out of ${outName}:\n  ` +
      missing.join('\n  '),
  );
}
if (lines.length === 0) {
  fail(
    'no asset carried a sha256 digest. GitHub always returns one for an uploaded asset, ' +
      'so this means the API contract changed — do not publish an empty checksum file.',
  );
}

writeFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
log(`wrote ${outName} with ${lines.length} checksum(s) from ${assets.length} asset(s)`);

/* ---------------------------------------------------------------- reporting */

const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
if (summaryFile) {
  const lines2 = [
    `**${outName}** — ${lines.length} checksum(s)`,
    ...(missing.length ? [`> No digest for: ${missing.join(', ')}`] : []),
    '',
  ];
  appendFileSync(summaryFile, `${lines2.join('\n')}\n`, 'utf8');
}
