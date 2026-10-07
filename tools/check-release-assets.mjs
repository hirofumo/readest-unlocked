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
 * The expected names are written out here rather than derived from the release
 * itself, because a derivation cannot notice a leftover — it would simply agree
 * with whatever is there. Changing the release's shape therefore means changing
 * this list, which is the point: the list is the contract, and this check runs
 * before a run stamps new manifests, checksums and provenance over the release.
 *
 * Unexpected assets are fatal. Missing ones are only reported: a leg that failed
 * leaves either nothing or the previous build's asset in place, and the updater
 * manifests already say which platforms are being offered.
 *
 * Usage:
 *   node tools/check-release-assets.mjs --repo <owner/repo> --tag <tag> --version <v>
 *
 * Reads GH_TOKEN / GITHUB_TOKEN when present to raise the rate limit.
 */

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

/* ------------------------------------------------------------- the contract */

const WINDOWS_ARCHES = ['x64', 'arm64'];
const MACOS_VARIANTS = ['x64', 'arm64', 'universal'];
const LINUX_ARCHES = ['x64', 'arm64'];
const ANDROID_FAMILIES = ['replace', 'coexist'];
const ANDROID_ABIS = ['universal', 'arm64-v8a', 'armeabi-v7a'];

function contract(version) {
  const expected = new Set();
  const add = (...names) => names.forEach((name) => expected.add(name));

  for (const arch of WINDOWS_ARCHES) {
    // The installer is the updater artifact, so it is signed; the portable build
    // is a zip and carries no signature.
    add(`Readest-${version}-windows-${arch}-setup.exe`, `Readest-${version}-windows-${arch}-setup.exe.sig`);
    add(`Readest-${version}-windows-${arch}-portable.zip`);
  }
  for (const variant of MACOS_VARIANTS) {
    // The dmg is for humans; the updater artifact is the .app tarball.
    add(`Readest-${version}-macos-${variant}.dmg`);
    add(`Readest-${version}-macos-${variant}-updater.tar.gz`, `Readest-${version}-macos-${variant}-updater.tar.gz.sig`);
  }
  for (const arch of LINUX_ARCHES) {
    // The AppImage is itself the updater artifact, so it is signed in place.
    add(`Readest-${version}-linux-${arch}.AppImage`, `Readest-${version}-linux-${arch}.AppImage.sig`);
    add(`Readest-${version}-linux-${arch}.deb`, `Readest-${version}-linux-${arch}.rpm`);
  }
  for (const family of ANDROID_FAMILIES) {
    for (const abi of ANDROID_ABIS) {
      add(`Readest-${version}-android-${family}-${abi}.apk`, `Readest-${version}-android-${family}-${abi}.apk.sig`);
    }
  }
  // iOS: unsigned on purpose, and not an updater target, so no .sig.
  add(`Readest-${version}-ios-arm64.ipa`);
  // The release's own documents, written by the pipeline rather than by a leg.
  add('SHA256SUMS', 'unlock.patch', 'BUILD.md', 'latest.json', 'latest-coexist.json', 'release-notes.json');

  return expected;
}

/* --------------------------------------------------------------- the check */

async function main() {
  const repo = arg('repo', process.env['GITHUB_REPOSITORY'] ?? '');
  const tag = arg('tag', '');
  const version = arg('version', '');

  if (!repo) fail('--repo is required (owner/repo)');
  if (!tag) fail('--tag is required');
  if (!version) fail('--version is required (the upstream version, e.g. 0.12.12)');

  const expected = contract(version);
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

  console.log(`[assets] release ${tag} holds ${actual.size} asset(s); the contract lists ${expected.size}`);

  if (unexpected.length) {
    fail(
      `${unexpected.length} asset(s) are not part of this release's shape:\n  ${unexpected.join('\n  ')}\n\n` +
        'Every one of them is a leftover: `--clobber` replaces by name, so nothing removes an\n' +
        'asset that a rebuild stopped producing. Remove them by hand:\n' +
        '  gh release delete-asset <tag> <name> --repo <owner/repo> --yes\n' +
        'and, if the release really did change shape, update the contract in this script.',
    );
  }

  if (missing.length) {
    console.warn(
      `[assets] WARNING: ${missing.length} expected asset(s) are not on the release:\n  ${missing.join('\n  ')}\n` +
        'A failed leg leaves its asset absent, or the previous build in place, and the updater\n' +
        'manifests report that platform; so this is not fatal on its own.',
    );
  }

  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      summaryFile,
      [
        `**release assets** — ${actual.size} present, contract ${expected.size}`,
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
