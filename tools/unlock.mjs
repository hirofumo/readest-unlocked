#!/usr/bin/env node
/**
 * Applies the "unlocked build" patch to a Readest checkout (readest/readest).
 *
 * Design rules:
 *   - Idempotent: running twice on an already patched tree is a no-op.
 *   - Anchor-based: every edit is anchored on exact upstream text. When an
 *     anchor is missing, the script fails with a non-zero exit code and prints
 *     what it expected. A locked build is never produced silently.
 *   - Minimal: one semantic change in the entitlement module, one config change
 *     that stops the official updater from re-locking the app, plus build env.
 *
 * Usage:
 *   node tools/unlock.mjs [--root <path-to-readest-checkout>]
 *
 * The root defaults to $READEST_ROOT, then to the current working directory.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '[readest-unlocked]';

/**
 * Where this build takes its updates from. The in-app updater is redirected
 * here so a shipped build can never be offered — and silently re-locked by — an
 * official release. Override with READEST_UNLOCKED_REPO if the repo moves.
 */
const REPO = process.env['READEST_UNLOCKED_REPO'] ?? 'hirofumo/readest-unlocked';
const REPO_URL = `https://github.com/${REPO}`;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASE_DOWNLOAD_BASE = `${REPO_URL}/releases/latest/download`;
const UPDATER_MANIFEST_URL = `${RELEASE_DOWNLOAD_BASE}/latest.json`;

/** Public half of the key in this repository's TAURI_SIGNING_PRIVATE_KEY. */
const UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg3RDUzQjUzOTgwNUM0NjgKUldSb3hBV1lVenZWaDM2Tk02R2hGY3U1M1VzRFl6WlZrTnUxYTJmT3FxbGF3bndzTG9RWlA5UmEK';

/* ------------------------------------------------------------------ helpers */

const parseRoot = () => {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const value = process.argv[i + 1];
    if (!value) fail('--root requires a path');
    return path.resolve(value);
  }
  return path.resolve(process.env['READEST_ROOT'] ?? process.cwd());
};

function fail(message) {
  console.error(`\n[unlock] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[unlock] ${message}`);
}

function warn(message) {
  console.warn(`[unlock] WARNING: ${message}`);
}

/** Read a file as LF text, remembering the original EOL style. */
function readText(file) {
  if (!existsSync(file)) fail(`expected file is missing: ${file}`);
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { text: raw.replace(/\r\n/g, '\n'), eol };
}

function writeText(file, text, eol) {
  writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8');
}

/**
 * Replace `anchor` with `replacement`. Refuses to continue when the anchor is
 * absent, because that means upstream moved the code we depend on.
 */
function replaceOnce(text, anchor, replacement, label) {
  const occurrences = text.split(anchor).length - 1;
  if (occurrences === 0) {
    fail(
      `${label}: anchor not found. Upstream changed this code; update tools/unlock.mjs.\n` +
        `  --- expected anchor ---\n${anchor}\n  -----------------------`,
    );
  }
  if (occurrences > 1) {
    fail(`${label}: anchor is ambiguous (${occurrences} matches); update tools/unlock.mjs.`);
  }
  return text.replace(anchor, replacement);
}

/* ------------------------------------------------------------ patch 1 + 2 */

const SENTINEL_GATE = `// ${MARKER} Premium gates are opened for this self-built fork.`;
const SENTINEL_MARKER = `// ${MARKER} Build marker: identifiable from the shipped bundle.`;
const SENTINEL_NOTICE = `{/* ${MARKER} modification notice (AGPL section 5) */}`;

const GATE_ANCHOR = `export const isCustomizationAllowed = (plan: UserPlan, customizationPurchased: boolean): boolean =>
  isSelfHosted() || customizationPurchased || PREMIUM_PLANS.includes(plan);`;

const GATE_REPLACEMENT = `export const isCustomizationAllowed = (plan: UserPlan, customizationPurchased: boolean): boolean => {
  ${SENTINEL_GATE}
  void plan;
  void customizationPurchased;
  return true;
};`;

const BUILD_MARKER_BLOCK = `
${SENTINEL_MARKER}
if (typeof globalThis !== 'undefined') {
  (globalThis as unknown as { __READEST_UNLOCKED__?: boolean }).__READEST_UNLOCKED__ = true;
}
`;

function patchAccessModule(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src', 'utils', 'access.ts');
  const { text: original, eol } = readText(file);
  let text = original;

  if (text.includes(SENTINEL_GATE)) {
    log('access.ts: entitlement gate already patched');
  } else {
    text = replaceOnce(text, GATE_ANCHOR, GATE_REPLACEMENT, 'access.ts/isCustomizationAllowed');
    log('access.ts: isCustomizationAllowed() now returns true for every plan');
  }

  if (text.includes(SENTINEL_MARKER)) {
    log('access.ts: build marker already present');
  } else {
    text = `${text.trimEnd()}\n${BUILD_MARKER_BLOCK}`;
    log('access.ts: added the __READEST_UNLOCKED__ build marker');
  }

  if (text !== original) writeText(file, text, eol);
}

/* ----------------------------------------------------------------- patch 3 */

function patchTauriConfig(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src-tauri', 'tauri.conf.json');
  const { text: original, eol } = readText(file);
  let text = original;

  // Repoint the updater at this project's own signed manifest. Leaving the
  // official endpoints in place would let the next "check for updates" install
  // an official release, which reinstates the paywall.
  const desiredEndpoints = `"endpoints": [\n        "${UPDATER_MANIFEST_URL}"\n      ]`;
  const endpointMatches = text.match(/"endpoints"\s*:\s*\[[^\]]*\]/g) ?? [];
  if (endpointMatches.length !== 1) {
    fail(
      `tauri.conf.json: expected exactly one "endpoints" array, found ${endpointMatches.length}. ` +
        'Upstream changed the updater config; update tools/unlock.mjs.',
    );
  }
  if (endpointMatches[0] === desiredEndpoints) {
    log('tauri.conf.json: updater endpoints already point at this project');
  } else {
    text = text.replace(/"endpoints"\s*:\s*\[[^\]]*\]/, desiredEndpoints);
    log(`tauri.conf.json: updater endpoints -> ${UPDATER_MANIFEST_URL}`);
  }

  // The manifest's signatures are verified against this public key, so it has
  // to be the one matching the private key held in the repository secrets.
  const desiredPubkey = `"pubkey": "${UPDATER_PUBKEY}"`;
  const pubkeyMatches = text.match(/"pubkey"\s*:\s*"[^"]*"/g) ?? [];
  if (pubkeyMatches.length !== 1) {
    fail(
      `tauri.conf.json: expected exactly one "pubkey", found ${pubkeyMatches.length}. ` +
        'Upstream changed the updater config; update tools/unlock.mjs.',
    );
  }
  if (pubkeyMatches[0] === desiredPubkey) {
    log("tauri.conf.json: updater pubkey is already this project's");
  } else {
    text = text.replace(/"pubkey"\s*:\s*"[^"]*"/, desiredPubkey);
    log("tauri.conf.json: updater pubkey replaced with this project's");
  }

  // Updater artifacts (and their .sig files) are what make an in-app update
  // possible at all; the private key comes from the repository secrets.
  if (text.includes('"createUpdaterArtifacts": true')) {
    log('tauri.conf.json: createUpdaterArtifacts already enabled');
  } else if (text.includes('"createUpdaterArtifacts": false')) {
    text = text.replace('"createUpdaterArtifacts": false', '"createUpdaterArtifacts": true');
    log('tauri.conf.json: createUpdaterArtifacts enabled');
  } else {
    fail('tauri.conf.json: no createUpdaterArtifacts flag; upstream changed the bundle config.');
  }

  if (text !== original) writeText(file, text, eol);

  // Validate the result and the invariants we promise not to break.
  let conf;
  try {
    conf = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`tauri.conf.json is not valid JSON after patching: ${err.message}`);
  }
  if (conf.bundle?.createUpdaterArtifacts !== true) {
    fail('bundle.createUpdaterArtifacts must be true for in-app updates to work');
  }
  const endpoints = conf.plugins?.updater?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1 || endpoints[0] !== UPDATER_MANIFEST_URL) {
    fail(
      `plugins.updater.endpoints must be [${UPDATER_MANIFEST_URL}], got ${JSON.stringify(endpoints)}`,
    );
  }
  if (conf.plugins?.updater?.pubkey !== UPDATER_PUBKEY) {
    fail("plugins.updater.pubkey is not this project's signing key");
  }
  if (conf.identifier !== 'com.bilingify.readest') {
    fail(`identifier changed unexpectedly: ${conf.identifier}`);
  }
  if (conf.productName !== 'Readest') {
    fail(`productName changed unexpectedly: ${conf.productName}`);
  }
}

/* --------------------------------------------------- app-level URLs + About */

/**
 * Every URL the app uses to fetch an update, a changelog or a download page.
 * Left as upstream ships them, "Check Update" would offer an official release
 * and reinstate the paywall it was built to avoid.
 */
function patchAppConstants(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src', 'services', 'constants.ts');
  const { text: original, eol } = readText(file);
  let text = original;

  const rewrites = [
    {
      label: 'update manifest base URL',
      pattern: /const LATEST_DOWNLOAD_BASE_URL = '[^']*';/,
      replacement: `const LATEST_DOWNLOAD_BASE_URL = '${RELEASE_DOWNLOAD_BASE}';`,
    },
    {
      // No separate nightly channel is published; pointing at a file that does
      // not exist keeps a nightly-channel client on the stable manifest instead
      // of reaching for upstream's nightly.
      label: 'nightly manifest URL',
      pattern: /export const READEST_NIGHTLY_UPDATER_FILE = '[^']*';/,
      replacement: `export const READEST_NIGHTLY_UPDATER_FILE = \`\${LATEST_DOWNLOAD_BASE_URL}/nightly.json\`;`,
    },
    {
      label: 'updater public key',
      pattern: /export const READEST_UPDATER_PUBKEY =\s*'[^']*';/,
      replacement: `export const READEST_UPDATER_PUBKEY =\n  '${UPDATER_PUBKEY}';`,
    },
    {
      label: 'download page URL',
      pattern: /export const DOWNLOAD_READEST_URL = '[^']*';/,
      replacement: `export const DOWNLOAD_READEST_URL = '${RELEASES_URL}';`,
    },
  ];

  for (const { label, pattern, replacement } of rewrites) {
    if (!pattern.test(text)) {
      fail(`constants.ts: ${label} not found; upstream changed these URLs. Update tools/unlock.mjs.`);
    }
    text = text.replace(pattern, () => replacement);
  }

  if (text !== original) writeText(file, text, eol);

  // The invariant that matters: nothing may still reach upstream's release host.
  if (/download\.readest\.com/.test(text)) {
    fail('constants.ts still references download.readest.com after patching');
  }
  log('constants.ts: update, changelog and download URLs point at this project');
}

/**
 * AGPL section 5 wants a modified version to carry a prominent notice, and the
 * About dialog is the one place a user actually reads.
 */
function patchAboutWindow(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src', 'components', 'AboutWindow.tsx');
  const { text: original, eol } = readText(file);
  if (original.includes(SENTINEL_NOTICE)) {
    log('AboutWindow.tsx: modification notice already present');
    return;
  }

  const anchor = `            <p className='text-neutral-content text-xs'>
              Source code is available at{' '}
              <Link href='https://github.com/readest/readest' className='text-blue-500 underline'>
                GitHub
              </Link>
              .
            </p>`;

  if (!original.includes(anchor)) {
    fail('AboutWindow.tsx: the source-code paragraph moved; update tools/unlock.mjs.');
  }

  const notice = `${anchor}
            ${SENTINEL_NOTICE}
            <p className='text-neutral-content text-xs'>
              This is an unofficial, modified build of Readest: the premium client features are
              unlocked, and updates come from this project&apos;s own releases instead of
              readest.com. Patches, build recipe and the full source for the changes live at{' '}
              <Link href='${REPO_URL}' className='text-blue-500 underline'>
                ${REPO}
              </Link>
              .
            </p>`;

  writeText(file, original.replace(anchor, () => notice), eol);
  log(`AboutWindow.tsx: added the modification notice and ${REPO_URL}`);
}

/* ------------------------------------------------- cosmetic UI (best effort) */

/**
 * The upgrade entry and the premium chips are driven by the *plan* rather than
 * by the entitlement helper, so the semantic patch does not remove them. They
 * are purely cosmetic — the underlying controls work regardless — so a moved
 * anchor warns instead of failing the run. Refusing to ship a working build
 * over a stray badge would be the wrong trade.
 */
const COSMETIC_PATCHES = [
  {
    label: 'library settings upgrade entry',
    file: ['apps', 'readest-app', 'src', 'app', 'library', 'components', 'SettingsMenu.tsx'],
    sentinel: `{/* ${MARKER} upgrade entry hidden in this build */}`,
    anchor: `      {user && userProfilePlan === 'free' && (
        <MenuItem label={_('Upgrade to Readest Premium')} onClick={handleUpgrade} />
      )}`,
    replacement: `      {/* ${MARKER} upgrade entry hidden in this build */}
      {false && user && userProfilePlan === 'free' && (
        <MenuItem label={_('Upgrade to Readest Premium')} onClick={handleUpgrade} />
      )}`,
  },
  {
    label: 'read-aloud offline-audio premium chip',
    file: [
      'apps',
      'readest-app',
      'src',
      'app',
      'reader',
      'components',
      'tts',
      'TTSPlayerSheet.tsx',
    ],
    sentinel: `${MARKER} entitled builds never chip this row`,
    anchor: `  const premiumBadge =
    !user || (userProfilePlan !== undefined && !isDownloadPremium) ? _('Premium') : undefined;`,
    replacement: `  // ${MARKER} entitled builds never chip this row, signed in or not
  const premiumBadge =
    !isDownloadPremium && (!user || (userProfilePlan !== undefined && !isDownloadPremium))
      ? _('Premium')
      : undefined;`,
  },
];

function patchCosmeticUi(root) {
  const skipped = [];
  for (const patch of COSMETIC_PATCHES) {
    const file = path.join(root, ...patch.file);
    const { text: original, eol } = readText(file);
    if (original.includes(patch.sentinel)) {
      log(`${patch.label}: already patched`);
      continue;
    }
    const occurrences = original.split(patch.anchor).length - 1;
    if (occurrences !== 1) {
      skipped.push(patch.label);
      warn(
        `${patch.label}: anchor not found (${occurrences} matches); cosmetic patch skipped. ` +
          'The feature still works, but the chip or upgrade entry may remain visible.',
      );
      continue;
    }
    writeText(file, original.replace(patch.anchor, patch.replacement), eol);
    log(`${patch.label}: hidden`);
  }
  return skipped;
}

/* ----------------------------------------------------------------- patch 4 */

const ENV_VARS = {
  NEXT_PUBLIC_APP_PLATFORM: 'tauri',
  NEXT_PUBLIC_SELF_HOSTED: 'true',
  SELF_HOSTED: 'true',
  NEXT_PUBLIC_STORAGE_FIXED_QUOTA: '53687091200',
  NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA: '500000',
};

/** Merge KEY=value pairs into a dotenv file without disturbing other lines. */
function mergeEnvFile(file, vars) {
  const eol = existsSync(file) && readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  const existing = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const lines = existing.length ? existing.replace(/\n$/, '').split('\n') : [];
  const seen = new Set();
  let changed = !existing.length;

  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (!match || !(match[1] in vars)) return line;
    seen.add(match[1]);
    const desired = `${match[1]}=${vars[match[1]]}`;
    if (line !== desired) changed = true;
    return desired;
  });

  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key)) continue;
    next.push(`${key}=${value}`);
    changed = true;
  }

  if (!changed) return false;
  writeFileSync(file, `${next.join(eol)}${eol}`, 'utf8');
  return true;
}

function writeBuildEnv(root) {
  const targets = [
    path.join(root, '.env.local'),
    path.join(root, 'apps', 'readest-app', '.env.local'),
  ];
  for (const file of targets) {
    const changed = mergeEnvFile(file, ENV_VARS);
    log(`${path.relative(root, file)}: ${changed ? 'written' : 'already up to date'}`);
  }
}

/* --------------------------------------------------------------------- main */

const root = parseRoot();
if (!existsSync(path.join(root, 'apps', 'readest-app'))) {
  fail(
    `not a Readest checkout (apps/readest-app not found): ${root}\n` +
      '  Clone readest/readest and run this script from its root, or pass --root.',
  );
}

log(`patching Readest checkout at ${root}`);
patchAccessModule(root);
patchTauriConfig(root);
patchAppConstants(root);
patchAboutWindow(root);
const skippedCosmetic = patchCosmeticUi(root);
writeBuildEnv(root);

if (skippedCosmetic.length) {
  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile) {
    appendFileSync(
      summaryFile,
      `> **Cosmetic patch skipped**: ${skippedCosmetic.join(', ')}. ` +
        'The premium features are unlocked; a badge or upgrade entry may still be visible.\n\n',
      'utf8',
    );
  }
  warn(`${skippedCosmetic.length} cosmetic patch(es) skipped — the build is still unlocked`);
}

log('done: this checkout will build without premium gates');
