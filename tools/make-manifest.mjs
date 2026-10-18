#!/usr/bin/env node
/**
 * Builds the signed updater manifests published with each release.
 *
 * The Tauri updater reads a manifest mapping a platform key to the URL of an
 * artifact plus the signature of that artifact. Each build leg uploads its .sig
 * file next to the artifact it signed, so this script only has to pair them and
 * name the platform keys.
 *
 * The manifest's `version` and the asset prefix are separate arguments: the
 * numbered release has both as `Readest-<version>-...`, while the daily
 * AutoBuild publishes `Readest-<date>-<sha>-...` assets under a date-based
 * manifest version (2026.1.1).
 *
 * Two manifests are produced for each channel:
 *   latest.json               desktop + the Android family that replaces the official app
 *   latest-coexist.json       the Android family that installs alongside it
 *   latest-autobuild.json     the same two shapes for the daily pre-release
 *   latest-autobuild-coexist.json
 *
 * The two Android families must stay separate in every channel: they have
 * different application ids, so offering one family's APK to the other would
 * install nothing useful.
 *
 * Usage:
 *   node tools/make-manifest.mjs --dir <sig-dir> --version <manifest version> \
 *        --out <file> [--prefix <asset prefix>] [--variant replace|coexist] \
 *        [--base-url <release download base>]
 *
 * Missing signatures are reported and skipped rather than fatal, so one
 * platform's packaging change cannot block the other platforms' updates — but an
 * empty manifest is an error, because publishing one would silently stop every
 * update.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://github.com/hirofumo/readest-unlocked/releases/latest/download';

// Platform keys mirror what upstream publishes, so a client computes the same
// lookup key whichever build it is running.
//
// Linux is the one that surprises people: the updater artifact is the AppImage
// itself, not a tarball. Upstream's manifest points both `linux-x86_64` and
// `linux-x86_64-appimage` at the AppImage asset, and the app's own AppImage
// update path downloads it, chmods it and launches it.
//
// There is deliberately no `windows-*-portable` entry: the portable download is
// a zip, and the updater downloads whatever an entry points at and launches it
// as an executable, so a zip entry would fail on every attempt. The portable
// variant is updated by downloading a new zip.
const DESKTOP_ENTRIES = [
  {
    keys: ['windows-x86_64', 'windows-x86_64-nsis'],
    asset: (p) => `${p}-windows-x64-setup.exe`,
  },
  {
    keys: ['windows-aarch64', 'windows-aarch64-nsis'],
    asset: (p) => `${p}-windows-arm64-setup.exe`,
  },
  {
    keys: ['darwin-x86_64', 'darwin-x86_64-app'],
    asset: (p) => `${p}-macos-x64-updater.tar.gz`,
  },
  {
    keys: ['darwin-aarch64', 'darwin-aarch64-app'],
    asset: (p) => `${p}-macos-arm64-updater.tar.gz`,
  },
  {
    keys: ['linux-x86_64', 'linux-x86_64-appimage'],
    asset: (p) => `${p}-linux-x64.AppImage`,
  },
  {
    keys: ['linux-aarch64', 'linux-aarch64-appimage'],
    asset: (p) => `${p}-linux-arm64.AppImage`,
  },
];

// Android clients derive their key from the device arch, and this recipe patches
// that derivation (`getAndroidPlatformKey` in `src/helpers/updater.ts`) to ask for
// one key per ABI: android-arm64, android-armv7, android-x86_64 and android-x86.
// Each manifest lists all four, each pointing at the APK built for that ABI, so
// every device is offered the package that fits it.
const ANDROID_ENTRIES = {
  replace: [
    { keys: ['android-arm64'], asset: (p) => `${p}-android-replace-arm64-v8a.apk` },
    { keys: ['android-armv7'], asset: (p) => `${p}-android-replace-armeabi-v7a.apk` },
    { keys: ['android-x86_64'], asset: (p) => `${p}-android-replace-x86_64.apk` },
    { keys: ['android-x86'], asset: (p) => `${p}-android-replace-x86.apk` },
  ],
  coexist: [
    { keys: ['android-arm64'], asset: (p) => `${p}-android-coexist-arm64-v8a.apk` },
    { keys: ['android-armv7'], asset: (p) => `${p}-android-coexist-armeabi-v7a.apk` },
    { keys: ['android-x86_64'], asset: (p) => `${p}-android-coexist-x86_64.apk` },
    { keys: ['android-x86'], asset: (p) => `${p}-android-coexist-x86.apk` },
  ],
};

function fail(message) {
  console.error(`\n[manifest] ERROR: ${message}\n`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const sigDir = path.resolve(arg('dir', 'sigs'));
const version = arg('version', '');
const prefix = arg('prefix', '') || `Readest-${version}`;
const outFile = path.resolve(arg('out', 'latest.json'));
const variant = arg('variant', 'replace');
const baseUrl = arg('base-url', DEFAULT_BASE_URL).replace(/\/+$/, '');

if (!version) fail('--version is required (the version the manifest advertises, e.g. 0.12.12)');
if (!prefix) fail('--prefix is empty');
if (variant !== 'replace' && variant !== 'coexist') {
  fail(`--variant must be "replace" or "coexist", got "${variant}"`);
}
if (!existsSync(sigDir)) fail(`signature directory does not exist: ${sigDir}`);

const entries =
  variant === 'coexist' ? ANDROID_ENTRIES.coexist : [...DESKTOP_ENTRIES, ...ANDROID_ENTRIES.replace];

const available = new Set(readdirSync(sigDir));
const platforms = {};
const missing = [];

for (const { keys, asset } of entries) {
  const name = asset(prefix);
  const sigName = `${name}.sig`;
  if (!available.has(sigName)) {
    missing.push(...keys);
    continue;
  }
  const signature = readFileSync(path.join(sigDir, sigName), 'utf8').trim();
  if (!signature) {
    missing.push(...keys);
    continue;
  }
  for (const key of keys) {
    platforms[key] = { signature, url: `${baseUrl}/${name}` };
  }
  console.log(`[manifest] ${keys.join(', ')} <- ${name}`);
}

const published = Object.keys(platforms);
if (published.length === 0) {
  fail(
    `no signatures found in ${sigDir} for variant "${variant}"; refusing to publish an empty manifest`,
  );
}
if (missing.length) {
  console.warn(
    `[manifest] WARNING: no signature for ${missing.join(', ')}. Those clients will not be ` +
      'offered an update until the artifact is published.',
  );
}

const manifest = {
  version,
  pub_date: new Date().toISOString(),
  notes: 'Automatically built unlocked Readest.',
  platforms,
};

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[manifest] wrote ${outFile} with ${published.length} platform key(s): ${published.join(', ')}`);

const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
if (summaryFile) {
  const lines = [
    `**${path.basename(outFile)}** — ${published.length} platform key(s): ${published.join(', ')}`,
    ...(missing.length ? [`> Missing signature for: ${missing.join(', ')}`] : []),
    '',
  ];
  const { appendFileSync } = await import('node:fs');
  appendFileSync(summaryFile, `${lines.join('\n')}\n`, 'utf8');
}
