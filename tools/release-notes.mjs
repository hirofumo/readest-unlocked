#!/usr/bin/env node
/**
 * Writes the release body: an English download-and-install guide.
 *
 * Both release channels share one structure — per-platform download sections,
 * each variant on its own line with one row of architecture links — because
 * that is the question a release page is opened to answer. The channels differ
 * only in what they are:
 *
 *   release    the numbered release, `v<version>`, with in-app updates
 *   nightly    the daily Nightly Build of upstream `main`, on the rolling
 *              `NightlyBuild` tag, replaced on every build and never published to
 *              the updater's `latest.json`
 *
 * Paragraphs are written as single lines on purpose: GitHub renders a release
 * body as Markdown, and a hand-wrapped sentence is noise in the rendered page.
 *
 * Usage:
 *   node tools/release-notes.mjs --mode release --version 0.12.16 \
 *     --prefix Readest-0.12.16 --tag v0.12.16 --repo owner/repo --out notes.md
 *
 *   node tools/release-notes.mjs --mode nightly --version 0.12.16 \
 *     --prefix Readest-2026.01.01-4aa4d9d --tag NightlyBuild --repo owner/repo \
 *     --date 2026.01.01 --short-sha 4aa4d9d --upstream-sha <40-char sha> \
 *     --out notes.md
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`\n[notes] ERROR: ${message}\n`);
  process.exit(1);
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const mode = arg('mode', 'release');
const version = arg('version');
const prefix = arg('prefix');
const tag = arg('tag');
const repo = arg('repo');
const date = arg('date');
const shortSha = arg('short-sha');
const upstreamSha = arg('upstream-sha');
const outFile = path.resolve(arg('out', 'release-body.md'));

if (mode !== 'release' && mode !== 'nightly') {
  fail(`--mode must be "release" or "nightly", got "${mode}"`);
}
for (const [name, value] of Object.entries({ version, prefix, tag, repo })) {
  if (!value) fail(`--${name} is required`);
}
if (mode === 'nightly') {
  for (const [name, value] of Object.entries({ date, 'short-sha': shortSha, 'upstream-sha': upstreamSha })) {
    if (!value) fail(`--${name} is required for --mode nightly`);
  }
}

// The release page is also the download page: each file name links to its own
// asset, so picking the right file does not require scrolling to the asset list.
const repoOwner = repo.split('/')[0] ?? '';
const defaultCoexistId = `com.${
  repoOwner.toLowerCase().replace(/[^a-z0-9]/g, '') || 'hirofumo'
}.readest.unlocked`;
const coexistId = arg('coexist-id', '') || defaultCoexistId;
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
// A variant line offers one file per architecture as a row of links, so the
// whole download section reads as "variant → your CPU" without a table.
const link = (label, suffix) => `[${label}](${baseUrl}/${prefix}-${suffix})`;
const archRow = (entries) => entries.map(([label, suffix]) => link(label, suffix)).join(' | ');
const shortCommit = upstreamSha ? upstreamSha.slice(0, 12) : shortSha;
const upstreamRef = arg('upstream-ref', '') || `v${version}`;
const upstreamRepo = arg('upstream-repo', 'readest/readest');

/* ------------------------------------------------------------------ sections */

const intro =
  mode === 'nightly'
    ? [
        `**Pre-release** — built from upstream \`main\` at [\`${shortCommit}\`](https://github.com/readest/readest/commit/${upstreamSha}) on ${date}.`,
        '',
        'This is the daily, rolling build of the next Readest tree. It is replaced by the next Nightly Build and may be unstable. Turn on **Settings → Control → Nightly Builds** to receive these builds through the in-app updater; otherwise download a new build here. Windows portable builds do not update in place.',
        '',
        `The unlocked patch is applied on top of upstream \`main\`; the files are named \`Readest-<date>-<upstream commit>-...\` so two builds cannot be confused.`,
      ]
    : [
        `**Numbered release** — Readest ${version}, built from upstream tag [\`${upstreamRef}\`](https://github.com/${upstreamRepo}/tree/${upstreamRef}).`,
        '',
        'This is the numbered release of the current Readest tree. It is the stable channel, and the app updates itself in place — except the Windows portable zip and the iOS IPA, which are described below.',
        '',
        `The unlocked patch is applied on top of upstream tag \`${upstreamRef}\`; the files are named \`Readest-${version}-<platform>-...\`.`,
      ];

const windowsSection = [
  '### Windows',
  '',
  '**Installer** — installs Readest and updates itself in place.',
  '',
  archRow([
    ['x86-64', 'windows-x64-setup.exe'],
    ['ARM64', 'windows-arm64-setup.exe'],
  ]),
  '',
  '**Portable** — unzip and run. It does not update itself.',
  '',
  archRow([
    ['x86-64', 'windows-x64-portable.zip'],
    ['ARM64', 'windows-arm64-portable.zip'],
  ]),
  '',
  'The `.sig` files next to the installers are updater signatures. The app downloads them itself; you do not need to save them by hand.',
].join('\n');

const macosSection = [
  '### macOS',
  '',
  '**Disk image** — install from the dmg; the app updates itself in place.',
  '',
  archRow([
    ['Intel', 'macos-x64.dmg'],
    ['Apple Silicon', 'macos-arm64.dmg'],
  ]),
  '',
  'The `-updater.tar.gz` archives are what the in-app updater downloads. Install from the dmg.',
].join('\n');

const linuxSection = [
  '### Linux',
  '',
  '**AppImage** — portable build for any distribution. Supports in-app updates.',
  '',
  archRow([
    ['x86-64', 'linux-x64.AppImage'],
    ['ARM64', 'linux-arm64.AppImage'],
  ]),
  '',
  '**Deb** — Debian, Ubuntu and derivatives.',
  '',
  archRow([
    ['x86-64', 'linux-x64.deb'],
    ['ARM64', 'linux-arm64.deb'],
  ]),
  '',
  '**RPM** — Fedora, RHEL and derivatives.',
  '',
  archRow([
    ['x86-64', 'linux-x64.rpm'],
    ['ARM64', 'linux-arm64.rpm'],
  ]),
  '',
  'Install a deb with `sudo apt install ./<file>.deb`, an rpm with `sudo dnf install ./<file>.rpm`, or make an AppImage executable with `chmod +x <file>.AppImage` and run it.',
].join('\n');

const androidSection = [
  '### Android',
  '',
  'There are two builds, and they can both be installed on the same device:',
  '',
  `- **Replacing** (\`com.bilingify.readest\`) — the same identity as the official app. Uninstall the official Readest first; its app-local data is cleared unless you restore it from a backup.`,
  `- **Coexisting** (\`${coexistId}\`) — installs next to the official app and starts with an empty library.`,
  '',
  'Each family updates itself in place. The two families have different application IDs and cannot update each other.',
  '',
  '**Replacing** — arm64-v8a for current phones and tablets, armeabi-v7a for older 32-bit ARM devices, x86_64 / x86 for emulators and x86 hardware.',
  '',
  archRow([
    ['arm64-v8a', 'android-replace-arm64-v8a.apk'],
    ['armeabi-v7a', 'android-replace-armeabi-v7a.apk'],
    ['x86_64', 'android-replace-x86_64.apk'],
    ['x86', 'android-replace-x86.apk'],
  ]),
  '',
  '**Coexisting** — same ABIs, its own application ID.',
  '',
  archRow([
    ['arm64-v8a', 'android-coexist-arm64-v8a.apk'],
    ['armeabi-v7a', 'android-coexist-armeabi-v7a.apk'],
    ['x86_64', 'android-coexist-x86_64.apk'],
    ['x86', 'android-coexist-x86.apk'],
  ]),
].join('\n');

const iosSection = [
  '### iOS',
  '',
  '**Unsigned IPA** — sign it with your own Apple ID before installing.',
  '',
  archRow([['arm64 — iPhone and iPad', 'ios-arm64.ipa']]),
  '',
  'Use AltStore, SideStore, Sideloadly or Xcode with your own provisioning profile. A free Apple ID cannot use App Groups, so the reading widget and the share extension will be degraded or unavailable; both need a paid team. The bundle ID is `com.bilingify.readest`, so installing over an App Store copy requires removing that copy first.',
].join('\n');

const verify = [
  '## Verify the download',
  '',
  'Every release publishes a `SHA256SUMS` file in `shasum` format:',
  '',
  '```bash',
  `gh release download ${tag} --repo ${repo} --pattern SHA256SUMS`,
  '# download the file you want, then:',
  'sha256sum -c SHA256SUMS --ignore-missing',
  '```',
  '',
  'A matching checksum proves the file arrived intact, not where it came from. For that, check the build provenance attestation:',
  '',
  '```bash',
  `gh attestation verify ${prefix}-windows-x64-setup.exe --repo ${repo}`,
  '```',
  '',
  'The command succeeds only for a file produced by a workflow run in this repository, and it prints the commit and run that produced it. It does not claim the code is harmless — read `unlock.patch` for that.',
].join('\n');

const about = [
  '## About this build',
  '',
  mode === 'nightly'
    ? 'This pre-release is upstream Readest `main` plus the patch scripts in this repository. The complete diff ships as `unlock.patch`, and `BUILD.md` records the exact upstream and recipe commits. It is rebuilt daily from upstream `main`; with Settings → Control → Nightly Builds enabled, the app follows this channel automatically. The numbered release is the stable channel.'
    : 'This is upstream Readest plus the patch scripts in this repository. The complete diff ships as `unlock.patch`, and `BUILD.md` records the exact upstream and recipe commits. Nothing is patched at runtime.',
  '',
  'Readest is licensed under **AGPL-3.0**, and so are these builds and the scripts that produce them.',
  '',
  'The binaries are not code-signed with a platform certificate. Windows SmartScreen and macOS Gatekeeper will warn on first launch. On macOS, clear the quarantine flag and open the app again:',
  '',
  '```bash',
  'xattr -cr /Applications/Readest.app',
  '```',
].join('\n');

const parts = [
  ...intro,
  '',
  '## Download and install',
  '',
  'Pick the file that matches your platform and architecture. Every file in this release was built from the same upstream commit and the same patch recipe.',
  '',
  windowsSection,
  '',
  macosSection,
  '',
  linuxSection,
  '',
  androidSection,
  '',
  iosSection,
  '',
  verify,
  '',
  about,
  '',
];

writeFileSync(outFile, parts.join('\n'), 'utf8');
console.log(
  `[notes] wrote ${path.basename(outFile)} for ${mode} ${tag}: ${parts.join('\n').split('\n').length} line(s)`,
);
