#!/usr/bin/env node
/**
 * Builds the signed updater manifests published with each release.
 *
 * The Tauri updater reads a manifest mapping a platform key to the URL of an
 * artifact plus the signature of that artifact. Each build leg uploads its .sig
 * file next to the artifact it signed, so this script only has to pair them and
 * name the platform keys.
 *
 * Two manifests are produced from the same release:
 *   latest.json         desktop + the Android family that replaces the official app
 *   latest-coexist.json the Android family that installs alongside it
 * They must stay separate: the two Android families have different application
 * ids, so offering one family's APK to the other would install nothing useful.
 *
 * Usage:
 *   node tools/make-manifest.mjs --dir <sig-dir> --version <v> --out <file>
 *        [--variant replace|coexist] [--base-url <release download base>]
 *
 * Missing signatures are reported and skipped rather than fatal, so one
 * platform's packaging change cannot block the other platforms' updates — but an
 * empty manifest is an error, because publishing one would silently stop every
 * update.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://github.com/hirofumo/readest-unlocked/releases/latest/download';

const DESKTOP_ENTRIES = [
  { keys: ['windows-x86_64'], asset: (v) => `Readest_${v}_x64-setup.exe` },
  { keys: ['windows-x86_64-portable'], asset: (v) => `Readest_${v}_x64-portable.exe` },
  { keys: ['darwin-aarch64', 'darwin-x86_64'], asset: (v) => `Readest_${v}_universal.app.tar.gz` },
  {
    keys: ['linux-x86_64', 'linux-x86_64-appimage'],
    asset: (v) => `Readest_${v}_x86_64.AppImage.tar.gz`,
  },
];

const ANDROID_ENTRIES = {
  replace: [
    { keys: ['android-universal'], asset: (v) => `Readest_${v}_universal.apk` },
    { keys: ['android-arm64'], asset: (v) => `Readest_${v}_arm64.apk` },
  ],
  coexist: [
    { keys: ['android-universal'], asset: (v) => `Readest_${v}_coexist-universal.apk` },
    { keys: ['android-arm64'], asset: (v) => `Readest_${v}_coexist-arm64.apk` },
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
const outFile = path.resolve(arg('out', 'latest.json'));
const variant = arg('variant', 'replace');
const baseUrl = arg('base-url', DEFAULT_BASE_URL).replace(/\/+$/, '');

if (!version) fail('--version is required (the upstream version, e.g. 0.12.12)');
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
  const name = asset(version);
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
