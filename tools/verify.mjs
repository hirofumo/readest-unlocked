#!/usr/bin/env node
/**
 * Verifies that a Readest checkout actually carries the unlocked-build patch.
 *
 * Runs after tools/unlock.mjs and before the expensive native build, so a broken
 * patch fails in seconds instead of forty minutes. It intentionally re-derives
 * the expected values instead of asking unlock.mjs what it did: a verifier that
 * trusts the patcher verifies nothing.
 *
 * Usage:
 *   node tools/verify.mjs [--root <path-to-readest-checkout>]
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '[readest-unlocked]';
const SENTINEL_GATE = `// ${MARKER} Premium gates are opened for this self-built fork.`;
const SENTINEL_MARKER = `// ${MARKER} Build marker: identifiable from the shipped bundle.`;
const SENTINEL_NOTICE = `{/* ${MARKER} modification notice (AGPL section 5) */}`;

const REPO = process.env['READEST_UNLOCKED_REPO'] ?? 'hirofumo/readest-unlocked';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASE_DOWNLOAD_BASE = `${REPO_URL}/releases/latest/download`;
const UPDATER_MANIFEST_URL = `${RELEASE_DOWNLOAD_BASE}/latest.json`;
const UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg3RDUzQjUzOTgwNUM0NjgKUldSb3hBV1lVenZWaDM2Tk02R2hGY3U1M1VzRFl6WlZrTnUxYTJmT3FxbGF3bndzTG9RWlA5UmEK';

const failures = [];

const fail = (message) => failures.push(message);
const ok = (message) => console.log(`  ok   ${message}`);

const parseRoot = () => {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const value = process.argv[i + 1];
    if (!value) {
      console.error('[verify] ERROR: --root requires a path');
      process.exit(1);
    }
    return path.resolve(value);
  }
  return path.resolve(process.env['READEST_ROOT'] ?? process.cwd());
};

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const lf = (text) => text.replace(/\r\n/g, '\n');

const root = parseRoot();
console.log(`[verify] checking ${root}\n`);

/* 1. the entitlement module ------------------------------------------------- */

const accessFile = path.join(root, 'apps', 'readest-app', 'src', 'utils', 'access.ts');
const access = read(accessFile);
if (access === null) {
  fail(`missing ${accessFile}`);
} else {
  const normalized = lf(access);
  if (normalized.includes(SENTINEL_GATE)) ok('access.ts carries the unlock sentinel');
  else fail('access.ts does not carry the unlock sentinel');

  const gateStart = normalized.indexOf('export const isCustomizationAllowed');
  const gateBody = gateStart === -1 ? '' : normalized.slice(gateStart, gateStart + 400);
  if (!gateBody) {
    fail('isCustomizationAllowed is missing from access.ts');
  } else if (gateBody.includes('return true;')) {
    ok('isCustomizationAllowed() returns true');
  } else {
    fail(`isCustomizationAllowed() does not return true:\n${gateBody.slice(0, 200)}`);
  }
  if (/PREMIUM_PLANS\.includes\(plan\)/.test(gateBody)) {
    fail('isCustomizationAllowed() still consults PREMIUM_PLANS');
  }

  if (normalized.includes(SENTINEL_MARKER) && normalized.includes('__READEST_UNLOCKED__')) {
    ok('access.ts carries the __READEST_UNLOCKED__ build marker');
  } else {
    fail('access.ts is missing the __READEST_UNLOCKED__ build marker');
  }
}

/* 2. the Tauri config ------------------------------------------------------- */

const confFile = path.join(root, 'apps', 'readest-app', 'src-tauri', 'tauri.conf.json');
const confRaw = read(confFile);
if (confRaw === null) {
  fail(`missing ${confFile}`);
} else {
  let conf;
  try {
    conf = JSON.parse(confRaw);
    ok('tauri.conf.json parses');
  } catch (err) {
    fail(`tauri.conf.json is not valid JSON: ${err.message}`);
  }
  if (conf) {
    if (conf.bundle?.createUpdaterArtifacts === true) {
      ok('bundle.createUpdaterArtifacts is on (in-app updates are possible)');
    } else {
      fail('bundle.createUpdaterArtifacts is off, so no build can ever be updated in place');
    }

    const endpoints = conf.plugins?.updater?.endpoints;
    if (Array.isArray(endpoints) && endpoints.length === 1 && endpoints[0] === UPDATER_MANIFEST_URL) {
      ok(`updater endpoints point only at this project (${UPDATER_MANIFEST_URL})`);
    } else {
      fail(`plugins.updater.endpoints must be [${UPDATER_MANIFEST_URL}], got ${JSON.stringify(endpoints)}`);
    }

    if (conf.plugins?.updater?.pubkey === UPDATER_PUBKEY) {
      ok("updater pubkey is this project's signing key");
    } else {
      fail("plugins.updater.pubkey is not this project's signing key");
    }

    if (conf.identifier === 'com.bilingify.readest') {
      ok('identifier unchanged (replaces the official install, keeps existing data)');
    } else {
      fail(`identifier changed: ${conf.identifier}`);
    }

    if (conf.productName === 'Readest') {
      ok('productName unchanged');
    } else {
      fail(`productName changed: ${conf.productName}`);
    }
  }
}

/* 3. app-level update URLs -------------------------------------------------- */

const constantsFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'constants.ts');
const constants = read(constantsFile);
if (constants === null) {
  fail(`missing ${constantsFile}`);
} else {
  const normalized = lf(constants);
  if (/download\.readest\.com/.test(normalized)) {
    fail('constants.ts still reaches download.readest.com; a "check for updates" would offer the official build');
  } else {
    ok('constants.ts reaches no upstream release host');
  }
  if (normalized.includes(RELEASE_DOWNLOAD_BASE)) {
    ok('constants.ts takes updates from this project');
  } else {
    fail(`constants.ts does not reference ${RELEASE_DOWNLOAD_BASE}`);
  }
  if (normalized.includes(UPDATER_PUBKEY)) {
    ok('constants.ts verifies artifacts with this project’s public key');
  } else {
    fail('constants.ts does not carry this project’s updater public key');
  }
  if (normalized.includes(RELEASES_URL)) {
    ok('the download entry point opens this project’s releases');
  } else {
    fail(`constants.ts does not reference ${RELEASES_URL}`);
  }
}

/* 4. the About dialog ------------------------------------------------------- */

const aboutFile = path.join(root, 'apps', 'readest-app', 'src', 'components', 'AboutWindow.tsx');
const about = read(aboutFile);
if (about === null) {
  fail(`missing ${aboutFile}`);
} else {
  const normalized = lf(about);
  if (normalized.includes(SENTINEL_NOTICE)) {
    ok('AboutWindow carries the modification notice');
  } else {
    fail('AboutWindow is missing the modification notice');
  }
  if (normalized.includes(REPO_URL)) {
    ok('AboutWindow links to this project');
  } else {
    fail(`AboutWindow does not link to ${REPO_URL}`);
  }
}

/* 5. build environment ------------------------------------------------------ */

for (const rel of [path.join('apps', 'readest-app', '.env.local'), '.env.local']) {
  const file = path.join(root, rel);
  const content = read(file);
  if (content === null) {
    fail(`missing ${rel}`);
    continue;
  }
  const vars = Object.fromEntries(
    lf(content)
      .split('\n')
      .map((line) => line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  if (vars['NEXT_PUBLIC_SELF_HOSTED'] === 'true') {
    ok(`${rel} sets NEXT_PUBLIC_SELF_HOSTED=true`);
  } else {
    fail(`${rel} does not set NEXT_PUBLIC_SELF_HOSTED=true`);
  }
}

/* 6. cosmetic patches (warnings only) --------------------------------------- */

const COSMETIC_SENTINELS = [
  [
    'library settings upgrade entry',
    path.join(root, 'apps', 'readest-app', 'src', 'app', 'library', 'components', 'SettingsMenu.tsx'),
    `{/* ${MARKER} upgrade entry hidden in this build */}`,
  ],
  [
    'read-aloud offline-audio premium chip',
    path.join(
      root,
      'apps',
      'readest-app',
      'src',
      'app',
      'reader',
      'components',
      'tts',
      'TTSPlayerSheet.tsx',
    ),
    `${MARKER} entitled builds never chip this row`,
  ],
];

const cosmeticMissing = [];
for (const [label, file, sentinel] of COSMETIC_SENTINELS) {
  if (read(file)?.includes(sentinel)) ok(`${label}: hidden`);
  else cosmeticMissing.push(label);
}
if (cosmeticMissing.length) {
  console.log(
    `  warn ${cosmeticMissing.length} cosmetic patch(es) not applied: ${cosmeticMissing.join(', ')}`,
  );
  console.log('       (features are unlocked; a badge or upgrade entry may still be visible)');
}

/* summary ------------------------------------------------------------------- */

console.log('');
if (failures.length) {
  console.error(`[verify] FAILED with ${failures.length} problem(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('[verify] all checks passed: this checkout builds unlocked and updates from this project');
