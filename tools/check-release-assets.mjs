#!/usr/bin/env node
/**
 * Asserts that a release holds exactly the assets this recipe publishes.
 *
 * `gh release upload --clobber` replaces an asset by name and never removes one,
 * so a rebuild cannot clean up after itself: when an asset is renamed, or a
 * platform is dropped, the old name stays on the release and keeps being
 * downloadable while the manifests and SHA256SUMS know nothing about it. Users
 * read that as "this platform still exists".
 *
 * The expected names live in `release-assets.mjs`, shared with the `detect` job:
 * a derivation from the release itself cannot notice a leftover — it would
 * simply agree with whatever is there — and a second hand-written copy would
 * drift away from this one. Changing the release's shape therefore means
 * changing that module, which is the point: the list is the contract, and this
 * check runs before a run stamps new manifests, checksums and provenance over
 * the release.
 *
 * Two channels are checked with the same contract:
 *
 *   release    assets `Readest-<version>-...`, plus latest.json,
 *              latest-coexist.json and release-notes.json
 *   nightly  assets `Readest-<date>-<sha>-...`, plus nightly.json
 *              and nightly-coexist.json — the daily pre-release never
 *              publishes the updated manifests the app actually follows
 *
 * Unexpected assets are fatal. Missing ones are only reported: a leg that failed
 * leaves either nothing or the previous build's asset in place, and the updater
 * manifests already say which platforms are being offered.
 *
 * Usage:
 *   node tools/check-release-assets.mjs --repo <owner/repo> --tag <tag> \
 *        --version <v> [--mode release|nightly] [--prefix <asset prefix>]
 *
 * Reads GH_TOKEN / GITHUB_TOKEN when present to raise the rate limit.
 */

import { expectedAssets } from './release-assets.mjs';

const TOKEN = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';

// This script talks to the API, so it must not call `process.exit()`: forcing an
// exit while a request handle is still around aborts the process on Windows
// (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) instead of returning
// the intended status. Failures are thrown and turned into an exit code at the
// bottom, so the process ends by itself.
class ContractFailure extends Error {}

function fail(message) {
  throw new ContractFailure(message);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

/* --------------------------------------------------------------- the check */

async function main() {
  const repo = arg('repo', process.env['GITHUB_REPOSITORY'] ?? '');
  const tag = arg('tag', '');
  const mode = arg('mode', 'release');
  const version = arg('version', '');
  const prefix = arg('prefix', '') || `Readest-${version}`;
  // Same expression the workflow's `detect` job materialises from the secret:
  // a fork without it never runs the Android legs, so their assets are not part
  // of that fork's contract and must not be reported as missing.
  const android = (process.env['HAS_ANDROID_KEY'] ?? 'true') !== 'false';

  if (!repo) fail('--repo is required (owner/repo)');
  if (!tag) fail('--tag is required');
  if (mode !== 'release' && mode !== 'nightly') {
    fail(`--mode must be "release" or "nightly", got "${mode}"`);
  }
  if (!prefix) fail('--prefix is empty');
  if (mode === 'nightly' && !arg('prefix', '')) {
    fail('--prefix is required with --mode nightly');
  }

  const expected = expectedAssets({ mode, prefix, android });
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'readest-unlocked-assets',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers,
  });
  if (!res.ok) fail(`could not read release ${tag} of ${repo}: HTTP ${res.status} ${res.statusText}`);
  const release = await res.json();

  const actual = new Set((release.assets ?? []).map((asset) => asset.name));
  if (actual.size === 0) fail(`release ${tag} has no assets; nothing to compare against the contract`);

  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  const missing = [...expected].filter((name) => !actual.has(name)).sort();

  console.log(
    `[assets] release ${tag} (${mode}) holds ${actual.size} asset(s); the contract lists ${expected.size}`,
  );

  if (unexpected.length) {
    fail(
      `${unexpected.length} asset(s) are not part of this release's shape:\n  ${unexpected.join('\n  ')}\n\n` +
        'Every one of them is a leftover: `--clobber` replaces by name, so nothing removes an\n' +
        'asset that a rebuild stopped producing. Remove them by hand:\n' +
        '  gh release delete-asset <tag> <name> --repo <owner/repo> --yes\n' +
        'and, if the release really did change shape, update the contract in tools/release-assets.mjs.',
    );
  }

  if (missing.length) {
    console.warn(
      `[assets] WARNING: ${missing.length} expected asset(s) are not on the release:\n  ${missing.join('\n  ')}\n` +
        'A failed leg leaves its asset absent, or the previous build in place, and the updater\n' +
        'manifests report that platform; so this is not fatal on its own. `detect` reads the\n' +
        'same contract, so the next run rebuilds instead of skipping a release that is short.',
    );
  }

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      summaryFile,
      [
        `**release assets** (${mode}) — ${actual.size} present, contract ${expected.size}`,
        ...(missing.length ? [`> Missing: ${missing.join(', ')}`] : []),
        '',
      ].join('\n') + '\n',
      'utf8',
    );
  }

  console.log(
    missing.length
      ? '[assets] no leftovers; some assets are missing (see the warning)'
      : '[assets] the release holds exactly what this recipe publishes',
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof ContractFailure) {
    console.error(`\n[assets] ERROR: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
