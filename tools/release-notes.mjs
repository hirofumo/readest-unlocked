#!/usr/bin/env node
/**
 * Writes the release body: an English download-and-install guide.
 *
 * Both release channels share one structure — a per-platform table of the files
 * in this release and what each one is for — because that is the question a
 * release page is opened to answer. The channels differ only in what they are:
 *
 *   release    the numbered release, `v<version>`, with in-app updates
 *   autobuild  the daily pre-release of upstream `main`, on the rolling
 *              `AutoBuild` tag, replaced on every build and never published to
 *              the updater's `latest.json`
 *
 * Usage:
 *   node tools/release-notes.mjs --mode release --version 0.12.16 \
 *     --prefix Readest-0.12.16 --tag v0.12.16 --repo owner/repo --out notes.md
 *
 *   node tools/release-notes.mjs --mode autobuild --version 0.12.16 \
 *     --prefix Readest-2026.01.01-4aa4d9d --tag AutoBuild --repo owner/repo \
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

if (mode !== 'release' && mode !== 'autobuild') {
  fail(`--mode must be "release" or "autobuild", got "${mode}"`);
}
for (const [name, value] of Object.entries({ version, prefix, tag, repo })) {
  if (!value) fail(`--${name} is required`);
}
if (mode === 'autobuild') {
  for (const [name, value] of Object.entries({ date, 'short-sha': shortSha, 'upstream-sha': upstreamSha })) {
    if (!value) fail(`--${name} is required for --mode autobuild`);
  }
}

const file = (suffix) => `\`${prefix}-${suffix}\``;
const shortCommit = upstreamSha ? upstreamSha.slice(0, 12) : shortSha;

/* ------------------------------------------------------------------ sections */

const intro =
  mode === 'autobuild'
    ? [
        `**Pre-release** — built from upstream \`main\` at [\`${shortCommit}\`]` +
          `(https://github.com/readest/readest/commit/${upstreamSha}) on ${date}.`,
        '',
        'This is the daily, rolling build of the next Readest tree. It is replaced',
        'by the next AutoBuild, it may be unstable, and it is **not** what the in-app',
        'updater follows — install a new build by downloading it again. The numbered',
        'release is the stable channel.',
        '',
        `The unlocked patch is applied on top of upstream \`main\`; the files are` +
          ' named `Readest-<date>-<upstream commit>-...` so two builds cannot be confused.',
      ]
    : [
        `**Unlocked build of Readest ${version}.** The client-side premium gates are`,
        'removed: third-party cloud sync (WebDAV, S3-compatible storage, Google Drive,',
        'OneDrive, iCloud Drive), per-chapter read-aloud audio download, Audiobookshelf',
        'offline downloads, trusted-device pairing, and custom translators. The app also',
        'gains a Self-hosted entry (Settings → Custom → Self-hosted) for pointing it at',
        'your own Readest server.',
        '',
        'Readest Cloud storage quota, the daily AI translation quota and the',
        'Send-to-Readest email address are still decided by the upstream service and are',
        'not unlocked by this build.',
      ];

const windowsTable = [
  '### Windows',
  '',
  '| File | Use it for |',
  '| --- | --- |',
  `| ${file('windows-x64-setup.exe')} | Windows 10/11 on Intel or AMD (x64). Installs Readest and supports in-app updates. |`,
  `| ${file('windows-arm64-setup.exe')} | Windows on ARM (arm64). Same installer and update support. |`,
  `| ${file('windows-x64-portable.zip')} | Portable x64 build; unzip and run. It does not update itself. |`,
  `| ${file('windows-arm64-portable.zip')} | Portable arm64 build; unzip and run. No self-update. |`,
  '',
  'The `.sig` files next to the installers are updater signatures. The app',
  'downloads them itself; you do not need to save them by hand.',
].join('\n');

const macosTable = [
  '### macOS',
  '',
  '| File | Use it for |',
  '| --- | --- |',
  `| ${file('macos-x64.dmg')} | Intel Macs. |`,
  `| ${file('macos-arm64.dmg')} | Apple silicon (M-series). |`,
  '',
  'The `-updater.tar.gz` archives are what the in-app updater downloads. Install',
  'from the dmg.',
].join('\n');

const linuxTable = [
  '### Linux',
  '',
  '| File | Use it for |',
  '| --- | --- |',
  `| ${file('linux-x64.AppImage')} | Portable x64 build for any distribution. Supports in-app updates. |`,
  `| ${file('linux-arm64.AppImage')} | Portable arm64 build. Supports in-app updates. |`,
  `| ${file('linux-x64.deb')} | Debian, Ubuntu and derivatives (x64). |`,
  `| ${file('linux-arm64.deb')} | Debian, Ubuntu and derivatives (arm64). |`,
  `| ${file('linux-x64.rpm')} | Fedora, RHEL and derivatives (x64). |`,
  `| ${file('linux-arm64.rpm')} | Fedora, RHEL and derivatives (arm64). |`,
  '',
  'Install a deb with `sudo apt install ./<file>.deb`, an rpm with',
  '`sudo dnf install ./<file>.rpm`, or make an AppImage executable with',
  '`chmod +x <file>.AppImage` and run it.',
].join('\n');

const androidTable = [
  '### Android',
  '',
  'There are two builds, and they can both be installed on the same device:',
  '',
  '- **Replacing** (`com.bilingify.readest`) — the same identity as the official',
  '  app. Uninstall the official Readest first; its app-local data is cleared unless',
  '  you restore it from a backup.',
  '- **Coexisting** (`com.hirofumo.readest.unlocked`) — installs next to the official',
  '  app and starts with an empty library.',
  '',
  'Pick the ABI that matches the device: `arm64-v8a` for current phones and',
  'tablets, `armeabi-v7a` for older 32-bit ARM devices, and `x86_64` / `x86` for',
  'emulators and x86 hardware.',
  '',
  '| File | Use it for |',
  '| --- | --- |',
  `| ${file('android-replace-arm64-v8a.apk')} | Replacing build, arm64-v8a. |`,
  `| ${file('android-replace-armeabi-v7a.apk')} | Replacing build, armeabi-v7a. |`,
  `| ${file('android-replace-x86_64.apk')} | Replacing build, x86_64. |`,
  `| ${file('android-replace-x86.apk')} | Replacing build, x86. |`,
  `| ${file('android-coexist-arm64-v8a.apk')} | Coexisting build, arm64-v8a. |`,
  `| ${file('android-coexist-armeabi-v7a.apk')} | Coexisting build, armeabi-v7a. |`,
  `| ${file('android-coexist-x86_64.apk')} | Coexisting build, x86_64. |`,
  `| ${file('android-coexist-x86.apk')} | Coexisting build, x86. |`,
  '',
  'Each family updates itself in place. The two families have different',
  'application IDs and cannot update each other.',
].join('\n');

const iosRow = [
  '### iOS',
  '',
  `| File | Use it for |`,
  '| --- | --- |',
  `| ${file('ios-arm64.ipa')} | iPhone and iPad (arm64). **Unsigned** — sign it with your own Apple ID before installing. |`,
  '',
  'Use AltStore, SideStore, Sideloadly or Xcode with your own provisioning',
  'profile. A free Apple ID cannot use App Groups, so the reading widget and the',
  'share extension will be degraded or unavailable; both need a paid team. The',
  'bundle ID is `com.bilingify.readest`, so installing over an App Store copy',
  'requires removing that copy first.',
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
  'A matching checksum proves the file arrived intact, not where it came from.',
  'For that, check the build provenance attestation:',
  '',
  '```bash',
  `gh attestation verify ${prefix}-windows-x64-setup.exe --repo ${repo}`,
  '```',
  '',
  'The command succeeds only for a file produced by a workflow run in this',
  'repository, and it prints the commit and run that produced it. It does not',
  'claim the code is harmless — read `unlock.patch` for that.',
].join('\n');

const about = [
  '## About this build',
  '',
  mode === 'autobuild'
    ? 'This pre-release is upstream Readest `main` plus the patch scripts in this' +
      ' repository. The complete diff ships as `unlock.patch`, and `BUILD.md` records' +
      ' the exact upstream and recipe commits. It is rebuilt daily from upstream' +
      ' `main`, so expect unfinished work; the numbered release is the stable channel.'
    : 'This is upstream Readest plus the patch scripts in this repository. The' +
      ' complete diff ships as `unlock.patch`, and `BUILD.md` records the exact' +
      ' upstream and recipe commits. Nothing is patched at runtime.',
  '',
  'Readest is licensed under **AGPL-3.0**, and so are these builds and the scripts',
  'that produce them.',
  '',
  'The binaries are not code-signed with a platform certificate. Windows',
  'SmartScreen and macOS Gatekeeper will warn on first launch. On macOS, clear the',
  'quarantine flag and open the app again:',
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
  'Pick the file that matches your platform and architecture. Every file in this',
  'release was built from the same upstream commit and the same patch recipe.',
  '',
  windowsTable,
  '',
  macosTable,
  '',
  linuxTable,
  '',
  androidTable,
  '',
  iosRow,
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
