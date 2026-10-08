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
/**
 * What the About dialog calls this project: the repository's own name, not the
 * `owner/name` slug, so the label still matches if READEST_UNLOCKED_REPO moves.
 */
const REPO_NAME = REPO.split('/').pop() ?? REPO;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASE_DOWNLOAD_BASE = `${REPO_URL}/releases/latest/download`;
const UPDATER_MANIFEST_URL = `${RELEASE_DOWNLOAD_BASE}/latest.json`;

/**
 * Public half of the key in this repository's TAURI_SIGNING_PRIVATE_KEY.
 *
 * Overridable on purpose. Tauri's updater takes a single `pubkey` (see
 * plugins/updater/src/config.rs — `pub: String`), so rotating the signing key
 * means shipping one release that is signed with the *old* key and carries the
 * *new* public key. Being able to do that by setting a variable, instead of
 * editing and re-verifying this file under time pressure, is the difference
 * between a rotation that works and one that gets rushed.
 *
 * `verify.mjs` reads the same variable; set it wherever either one runs.
 */
const UPDATER_PUBKEY =
  // `||` and not `??`: an unset GitHub variable arrives as an empty string, and
  // an empty pubkey would silently produce a build that can never verify an
  // update. Same trap `isSelfHosted()` documents upstream.
  process.env['READEST_UNLOCKED_UPDATER_PUBKEY'] ||
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
const SENTINEL_CONSTANTS = `// ${MARKER} Update endpoints and signing key are this project's.`;

function patchAppConstants(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src', 'services', 'constants.ts');
  const { text: original, eol } = readText(file);

  // Already done: re-running must be a no-op rather than an anchor mismatch,
  // because one of the rewrites below changes a value's quote style. The
  // sentinel is part of the test, so a tree patched by an earlier revision of
  // this script is brought up to date instead of being skipped.
  if (
    original.includes(RELEASE_DOWNLOAD_BASE) &&
    original.includes(SENTINEL_CONSTANTS) &&
    !original.includes('download.readest.com')
  ) {
    log('constants.ts: already points at this project');
    return;
  }

  let text = original;

  const rewrites = [
    {
      label: 'update manifest base URL',
      pattern: /const LATEST_DOWNLOAD_BASE_URL = '[^']*';/,
      replacement: `${SENTINEL_CONSTANTS}\nconst LATEST_DOWNLOAD_BASE_URL = '${RELEASE_DOWNLOAD_BASE}';`,
    },
    {
      // No separate nightly channel is published; pointing at a file that does
      // not exist keeps a nightly-channel client on the stable manifest instead
      // of reaching for upstream's nightly.
      //
      // The quote class accepts both forms: this rewrite turns the value into a
      // template literal, so a second run has to recognise its own output.
      label: 'nightly manifest URL',
      pattern: /export const READEST_NIGHTLY_UPDATER_FILE = [`'][^`']*[`'];/,
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
 * The two repository links in the notice name the project, not the `owner/name`
 * slug it lives under. A tree patched by an earlier revision of this script
 * already carries the notice with the old labels — there is no upstream text
 * left to anchor on — so the labels are repaired in place.
 */
const ABOUT_LINK_LABELS = [
  {
    label: 'AboutWindow.tsx/upstream link label',
    from: `<Link href='https://github.com/readest/readest' className='text-blue-500 underline'>\n                github.com/readest/readest\n              </Link>`,
    to: `<Link href='https://github.com/readest/readest' className='text-blue-500 underline'>\n                readest\n              </Link>`,
  },
  {
    label: 'AboutWindow.tsx/project link label',
    from: `<Link href='${REPO_URL}' className='text-blue-500 underline'>\n                ${REPO}\n              </Link>`,
    // Split across lines like the licence link above it: the one-line form broke
    // the formatter's 100 columns once the label stopped being the URL.
    to: `<Link\n                href='${REPO_URL}'\n                className='text-blue-500 underline'\n              >\n                ${REPO_NAME}\n              </Link>`,
  },
];

/**
 * AGPL section 5 wants a modified version to carry a prominent notice, and the
 * About dialog is the one place a user actually reads.
 */
function patchAboutWindow(root) {
  const file = path.join(root, 'apps', 'readest-app', 'src', 'components', 'AboutWindow.tsx');
  const { text: original, eol } = readText(file);

  const needsNotice = !original.includes(SENTINEL_NOTICE);
  if (!needsNotice) log('AboutWindow.tsx: modification notice already present');

  const anchor = `            <p className='text-neutral-content text-xs'>
              This software is licensed under the{' '}
              <Link
                href='https://www.gnu.org/licenses/agpl-3.0.html'
                className='text-blue-500 underline'
              >
                GNU Affero General Public License v3.0
              </Link>
              . You are free to use, modify, and distribute this software under the terms of the
              AGPL v3 license. Please see the license for more details.
            </p>
            <p className='text-neutral-content text-xs'>
              Source code is available at{' '}
              <Link href='https://github.com/readest/readest' className='text-blue-500 underline'>
                GitHub
              </Link>
              .
            </p>`;

  if (needsNotice && !original.includes(anchor)) {
    fail('AboutWindow.tsx: the licence and source paragraphs moved; update tools/unlock.mjs.');
  }

  // Upstream's licence line, its upstream-source line and this build's
  // provenance are one statement about where the software comes from, so they
  // read as one paragraph rather than as the original notice with a
  // modification bolted on below it.
  const notice = `            ${SENTINEL_NOTICE}
            <p className='text-neutral-content text-xs'>
              Readest is licensed under the{' '}
              <Link
                href='https://www.gnu.org/licenses/agpl-3.0.html'
                className='text-blue-500 underline'
              >
                GNU Affero General Public License v3.0
              </Link>
              , and you are free to use, modify and distribute it under those terms. The upstream
              source is at{' '}
              <Link href='https://github.com/readest/readest' className='text-blue-500 underline'>
                readest
              </Link>
              . This copy is an unofficial, modified build of it: the premium client features are
              unlocked, and updates come from this project&apos;s own releases instead of
              readest.com. The patches and the exact build recipe are at{' '}
              <Link
                href='${REPO_URL}'
                className='text-blue-500 underline'
              >
                ${REPO_NAME}
              </Link>
              .
            </p>`;

  let text = needsNotice ? original.replace(anchor, () => notice) : original;
  if (needsNotice) {
    log('AboutWindow.tsx: merged the licence, upstream source and modification notices');
  }

  for (const { label, from, to } of ABOUT_LINK_LABELS) {
    // Absent = this tree already carries the project-name label.
    if (!text.includes(from)) continue;
    text = replaceOnce(text, from, to, label);
    log(`${label}: repository link now shows the project name`);
  }

  if (text !== original) writeText(file, text, eol);
}

/* -------------------------------------------------- self-hosted server URL */

/**
 * Lets the app be pointed at a self-hosted Readest instead of the official
 * servers, without rebuilding.
 *
 * Three surfaces have to move together for a self-hosted backend to work:
 *
 *   - `apiBaseUrl`  the web/API origin, read by getBaseUrl()
 *   - `nodeBaseUrl` the Node API origin, read by getNodeBaseUrl() — upstream
 *                   does not consult the runtime config there at all, so
 *                   without this the Node endpoints still go to readest.com
 *   - `supabaseUrl` and `supabaseAnonKey`  the account backend. The key is
 *                   optional: a deployment that reuses the official project
 *                   keys, or runs no accounts at all, has no use for it.
 *
 * All of them are read through getRuntimeConfig(), so overriding that one
 * function covers the lot and a Settings entry is the only UI needed.
 */
const SERVER_URL_KEY = 'readest.serverUrl';
const SERVER_ANON_KEY = 'readest.supabaseAnonKey';
/**
 * Whether the stored server is the one the app talks to. Disconnecting clears this
 * switch and keeps the URL, so reconnecting is one click — the behaviour the WebDAV
 * panel has, where its credentials survive a disconnect.
 */
const SERVER_ENABLED_KEY = 'readest.serverEnabled';

const RUNTIME_CONFIG_TYPE_ANCHOR = `  apiBaseUrl?: string;`;

const RUNTIME_CONFIG_ANCHOR = `export const getRuntimeConfig = () =>
  typeof window === 'undefined' ? undefined : window.__READEST_RUNTIME_CONFIG;`;

const RUNTIME_CONFIG_REPLACEMENT = `// ${MARKER} keys shared with the Settings entry in MiscPanel.
export const CUSTOM_SERVER_URL_KEY = '${SERVER_URL_KEY}';
export const CUSTOM_SERVER_ANON_KEY = '${SERVER_ANON_KEY}';
export const CUSTOM_SERVER_ENABLED_KEY = '${SERVER_ENABLED_KEY}';

const readStoredSetting = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage?.getItem(key) || null;
  } catch {
    // A webview with storage disabled must not break startup.
    return null;
  }
};

/** The user's self-hosted server URL, remembered even while disconnected. */
export const getCustomServerUrl = (): string | null => readStoredSetting(CUSTOM_SERVER_URL_KEY);

/**
 * Whether the app is pointed at that server right now. Disconnecting clears only
 * this switch, so the address survives and a reconnect is one click — and an
 * address stored by a build that predates the switch still counts as enabled,
 * because only the explicit 'false' turns it off.
 */
export const isCustomServerEnabled = (): boolean =>
  readStoredSetting(CUSTOM_SERVER_ENABLED_KEY) !== 'false';

/**
 * Everything a self-hosted deployment replaces. One origin covers all three by
 * default: a Readest server serves the web app, the API and the Node API from
 * the same host.
 */
export const getCustomServerConfig = (): ReadestRuntimeConfig | null => {
  const url = getCustomServerUrl();
  if (!url || !isCustomServerEnabled()) return null;
  const anonKey = readStoredSetting(CUSTOM_SERVER_ANON_KEY);
  return {
    apiBaseUrl: url,
    nodeBaseUrl: url,
    supabaseUrl: url,
    ...(anonKey ? { supabaseAnonKey: anonKey } : {}),
  };
};

export const getRuntimeConfig = (): ReadestRuntimeConfig | undefined => {
  if (typeof window === 'undefined') return undefined;
  const base = window.__READEST_RUNTIME_CONFIG;
  const custom = getCustomServerConfig();
  if (!custom) return base;
  return { ...base, ...custom };
};`;

/**
 * The self-hosted entry is a second-level page — a row in the Custom list that
 * pushes into a sub-page — and it mirrors the WebDAV panel: while no server is
 * configured it is that panel's connect form (filled Connect button, probe,
 * toasts), and once one is it is the connected view with a Disconnect button.
 *
 * `SENTINEL_SELF_HOSTED` marks the generated page and `PANEL_STATE_SENTINEL` the
 * state block; together they are both the "already patched" test and how a tree
 * carrying an earlier revision of this patch is recognised instead of being
 * patched twice.
 */
const SENTINEL_SELF_HOSTED = `{/* ${MARKER} self-hosted sub-page, reached from the Custom list like Integrations → WebDAV */}`;
const PANEL_STATE_SENTINEL = `  // ${MARKER} self-hosted server override`;

/** Upstream's import line, which the panel's new row and page extend. */
const PANEL_IMPORT_ANCHOR = `import { BoxedList } from './primitives';`;
const PANEL_IMPORTS = `import { BoxedList, NavigationRow, SectionTitle, Tips } from './primitives';
import SubPageHeader from './SubPageHeader';
import { useKeyDownActions } from '@/hooks/useKeyDownActions';
import { eventDispatcher } from '@/utils/event';
import { fetchWithTimeout } from '@/utils/fetch';
import { isCustomServerEnabled } from '@/services/runtimeConfig';`;

/**
 * The server state, written whole. The two long initialisers are wrapped the way
 * the formatter wants them (100 columns), so a patched tree survives `pnpm format`
 * untouched.
 */
const PANEL_STATE_BLOCK = `  // ${MARKER} self-hosted server override. The address these fields write is read
  // by services/runtimeConfig.ts, and so is the switch that says whether the app
  // is pointed at it.
  const [draftServerUrl, setDraftServerUrl] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (window.localStorage?.getItem('${SERVER_URL_KEY}') ?? ''),
  );
  const [draftAnonKey, setDraftAnonKey] = useState<string>(() =>
    typeof window === 'undefined'
      ? ''
      : (window.localStorage?.getItem('${SERVER_ANON_KEY}') ?? ''),
  );
  const [showSelfHosted, setShowSelfHosted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  /** Whether the stored server is the active one — the switch Disconnect clears. */
  const [isServerConfigured, setIsServerConfigured] = useState<boolean>(
    () => isCustomServerEnabled() && !!draftServerUrl,
  );
  const storeServerSettings = (url: string, anonKey: string, enabled: boolean) => {
    const store = (key: string, value: string) => {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    };
    store('${SERVER_URL_KEY}', url);
    store('${SERVER_ANON_KEY}', anonKey);
    // An explicit 'false' keeps the address but stops the app from using it.
    store('${SERVER_ENABLED_KEY}', enabled ? 'true' : 'false');
  };
  // Connect probes the origin once, the way the WebDAV panel probes its server:
  // the app's own fetch helper, so the answer matches what the app itself will
  // experience, and the same user-facing strings. Any answer means the host is
  // there — only a dead host or a 5xx refuses the connect, because a stricter
  // status check would reject working setups that sit behind a reverse proxy.
  const checkServerReachable = async (url: string): Promise<string | null> => {
    let target: URL;
    try {
      // A bare host:port is not a URL at all: it would be resolved relative to the
      // app's own origin and probe that instead. Anything that is not http(s) is
      // rejected before a request is made.
      target = new URL(\`\${url}/\`);
    } catch {
      return _('Please enter a valid http(s) URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return _('Please enter a valid http(s) URL');
    }
    try {
      const response = await fetchWithTimeout(target.toString(), { method: 'GET' });
      if (response.status >= 500) {
        return _('Unexpected server response (status {{status}})', { status: response.status });
      }
      return null;
    } catch (error) {
      return \`\${_('Network error')}: \${error instanceof Error ? error.message : String(error)}\`;
    }
  };
  // Both the API base and the Supabase client are resolved once, at startup, so a
  // change only takes effect after a reload — and the toast has to paint first.
  const restartWithNotice = (message: string) => {
    eventDispatcher.dispatch('toast', { type: 'info', message });
    window.setTimeout(() => window.location.reload(), 1200);
  };
  const handleConnect = async () => {
    const url = draftServerUrl.trim().replace(/\\/+$/, '');
    if (!url) return;
    setIsConnecting(true);
    const problem = await checkServerReachable(url);
    setIsConnecting(false);
    if (problem) {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: \`\${_('Failed to connect')}: \${problem}\`,
      });
      return;
    }
    setDraftServerUrl(url);
    setIsServerConfigured(true);
    storeServerSettings(url, draftAnonKey.trim(), true);
    restartWithNotice(_('Connected'));
  };
  const handleDisconnect = () => {
    // Keep the address so a reconnect is one click, the way the WebDAV panel keeps
    // its credentials; only the switch goes off, and the app falls back to the
    // official servers on the reload.
    setIsServerConfigured(false);
    storeServerSettings(draftServerUrl, draftAnonKey, false);
    restartWithNotice(_('Disconnected'));
  };
  // Android Back / Esc steps out of the sub-page instead of closing Settings, the
  // way the Integrations sub-pages behave.
  useKeyDownActions({ enabled: showSelfHosted, onCancel: () => setShowSelfHosted(false) });
`;

/** The component's main `return`, which the sub-page is emitted above. */
const PANEL_RETURN_ANCHOR = `  return (
    <div
      className={clsx(
        'my-4 w-full space-y-6',`;

/** The list row that pushes into the sub-page, with its connection status. */
const PANEL_ROW = `      <BoxedList data-setting-id='settings.custom.selfHosted'>
        <NavigationRow
          title={_('Self-hosted')}
          status={isServerConfigured ? _('Connected') : _('Not connected')}
          onClick={() => setShowSelfHosted(true)}
        />
      </BoxedList>
`;

const PANEL_SUB_PAGE = `  if (showSelfHosted) {
    return (
      <div className='my-4 w-full'>
        ${SENTINEL_SELF_HOSTED}
        <SubPageHeader
          parentLabel={_('Custom')}
          currentLabel={_('Self-hosted')}
          description={_('Connect the app to your own Readest server')}
          onBack={() => setShowSelfHosted(false)}
        />
        {isServerConfigured ? (
          <div className='space-y-5'>
            <p className='text-base-content/70 px-4 text-sm leading-relaxed break-all'>
              {_('Connected to {{url}}', { url: draftServerUrl })}
            </p>
            <div className='flex justify-end'>
              <button
                type='button'
                onClick={handleDisconnect}
                className={clsx(
                  'eink-bordered',
                  'h-10 rounded-lg px-4 text-sm font-medium',
                  'text-error hover:bg-error/10',
                  'transition-colors duration-150',
                  'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
                )}
              >
                {_('Disconnect')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault();
              void handleConnect();
            }}
          >
            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='selfHostedServerUrl' className='block'>
                {_('Server URL')}
              </SectionTitle>
              <input
                id='selfHostedServerUrl'
                className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
                type='text'
                inputMode='url'
                spellCheck='false'
                autoCapitalize='off'
                autoCorrect='off'
                placeholder='https://readest.com'
                value={draftServerUrl}
                onChange={(event) => setDraftServerUrl(event.target.value)}
              />
            </div>

            <div className='space-y-1.5'>
              <SectionTitle as='label' htmlFor='selfHostedAnonKey' className='block'>
                {_('Supabase anon key (optional)')}
              </SectionTitle>
              <input
                id='selfHostedAnonKey'
                className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
                type='text'
                spellCheck='false'
                autoCapitalize='off'
                autoCorrect='off'
                value={draftAnonKey}
                onChange={(event) => setDraftAnonKey(event.target.value)}
              />
            </div>

            <div className='flex justify-end pt-1'>
              <button
                type='submit'
                disabled={isConnecting || !draftServerUrl}
                className={clsx(
                  'btn btn-contrast',
                  'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
                  'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
                  isConnecting && 'opacity-60',
                )}
              >
                {isConnecting ? (
                  <span className='loading loading-spinner loading-sm' />
                ) : (
                  _('Connect')
                )}
              </button>
            </div>
          </form>
        )}

        <div className='mt-5'>
          <Tips>
            <li>
              {_(
                'Point the app at your own Readest server. Disconnecting returns to the official servers.',
              )}
            </li>
          </Tips>
        </div>
      </div>
    );
  }

`;

function patchServerUrlSetting(root) {
  /* runtimeConfig.ts: accept a node base URL, then honour the stored override */
  const configFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'runtimeConfig.ts');
  const { text: configSource0, eol: configEol } = readText(configFile);
  let configSource = configSource0;

  if (configSource.includes('nodeBaseUrl?: string;')) {
    log('runtimeConfig.ts: runtime config already accepts a node base URL');
  } else {
    configSource = replaceOnce(
      configSource,
      RUNTIME_CONFIG_TYPE_ANCHOR,
      `  apiBaseUrl?: string;\n  nodeBaseUrl?: string;`,
      'runtimeConfig.ts/ReadestRuntimeConfig',
    );
    log('runtimeConfig.ts: runtime config accepts a node base URL');
  }

  if (configSource.includes(`${MARKER} keys shared with the Settings entry`)) {
    log('runtimeConfig.ts: server override already present');
  } else {
    configSource = replaceOnce(
      configSource,
      RUNTIME_CONFIG_ANCHOR,
      RUNTIME_CONFIG_REPLACEMENT,
      'runtimeConfig.ts/getRuntimeConfig',
    );
    log('runtimeConfig.ts: a configured server redirects the API, the Node API and the account backend');
  }

  if (configSource !== configSource0) writeText(configFile, configSource, configEol);

  /* environment.ts: getNodeBaseUrl has no runtime-config branch upstream */
  const envFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'environment.ts');
  const { text: envSource0, eol: envEol } = readText(envFile);
  let envSource = envSource0;
  const nodeAnchor = `export const getNodeBaseUrl = () =>
  process.env['NEXT_PUBLIC_NODE_BASE_URL'] ?? READEST_NODE_BASE_URL;`;

  if (envSource.includes(`${MARKER} node base URL`)) {
    log('environment.ts: node base override already present');
  } else {
    envSource = replaceOnce(
      envSource,
      nodeAnchor,
      `export const getNodeBaseUrl = () =>
  // ${MARKER} node base URL, so a self-hosted server is not bypassed for the
  // endpoints that go through the Node runtime.
  getRuntimeConfig()?.nodeBaseUrl ??
  process.env['NEXT_PUBLIC_NODE_BASE_URL'] ??
  READEST_NODE_BASE_URL;`,
      'environment.ts/getNodeBaseUrl',
    );
    writeText(envFile, envSource, envEol);
    log('environment.ts: the Node API follows the configured server');
  }

  /* deeplink.ts: annotation links should point at the configured server */
  const linkFile = path.join(root, 'apps', 'readest-app', 'src', 'utils', 'deeplink.ts');
  const { text: linkSource0, eol: linkEol } = readText(linkFile);
  let linkSource = linkSource0;

  if (linkSource.includes(`${MARKER} annotation links`)) {
    log('deeplink.ts: annotation links already follow the configured server');
  } else {
    linkSource = replaceOnce(
      linkSource,
      `  const base = \`\${READEST_WEB_BASE_URL}\${ANNOTATION_PATH_PREFIX}\${bookHash}/annotation/\${noteId}\`;`,
      `  // ${MARKER} annotation links follow whichever server this build talks to.
  const base = \`\${getBaseUrl()}\${ANNOTATION_PATH_PREFIX}\${bookHash}/annotation/\${noteId}\`;`,
      'deeplink.ts/buildAnnotationWebUrl',
    );
    linkSource = replaceOnce(
      linkSource,
      `import { READEST_WEB_BASE_URL } from '@/services/constants';`,
      `import { getBaseUrl } from '@/services/environment';`,
      'deeplink.ts/import',
    );
    writeText(linkFile, linkSource, linkEol);
    log('deeplink.ts: annotation links follow the configured server');
  }

  const panelFile = path.join(root, 'apps', 'readest-app', 'src', 'components', 'settings', 'MiscPanel.tsx');
  const { text: panelSource, eol: panelEol } = readText(panelFile);

  // The entry gained a second-level page in a later revision of this patch, and an
  // earlier one of those revisions cannot be upgraded in place — its upstream
  // anchors are gone — so it is reported instead of being patched twice.
  if (panelSource.includes(SENTINEL_SELF_HOSTED) && panelSource.includes('const handleConnect =')) {
    log('MiscPanel.tsx: self-hosted sub-page already present');
    return;
  }
  if (
    panelSource.includes(SENTINEL_SELF_HOSTED) ||
    panelSource.includes(PANEL_STATE_SENTINEL) ||
    panelSource.includes('settings.custom.serverUrl')
  ) {
    fail(
      'MiscPanel.tsx carries an earlier revision of this patch, which cannot be upgraded in place.\n' +
        '  Restore the file and run this script again:\n' +
        `    git -C ${root} checkout -- apps/readest-app/src/components/settings/MiscPanel.tsx\n` +
        '  (This checkout is for local verification only; CI always starts from upstream.)',
    );
  }

  let panel = replaceOnce(panelSource, PANEL_IMPORT_ANCHOR, PANEL_IMPORTS, 'MiscPanel.tsx/imports');

  const stateAnchor = `  const [inputFocusInAndroid, setInputFocusInAndroid] = useState(false);`;
  const jsxAnchor = `        'settings.custom.readerUiCss',
      )}
    </div>
  );
};`;

  const jsxReplacement = `        'settings.custom.readerUiCss',
      )}

${PANEL_ROW}    </div>
  );
};`;

  panel = replaceOnce(panel, stateAnchor, `${stateAnchor}\n${PANEL_STATE_BLOCK}`, 'MiscPanel.tsx/state');
  panel = replaceOnce(panel, jsxAnchor, jsxReplacement, 'MiscPanel.tsx/serverUrlRow');
  panel = replaceOnce(
    panel,
    PANEL_RETURN_ANCHOR,
    `${PANEL_SUB_PAGE}${PANEL_RETURN_ANCHOR}`,
    'MiscPanel.tsx/subPage',
  );

  writeText(panelFile, panel, panelEol);
  log('MiscPanel.tsx: the Self-hosted entry opens a second-level page');
}

/* ------------------------------------------------------------ translations */

/**
 * The strings the self-hosted entry adds that no locale carries yet. Everything
 * else on that page reuses keys that are already translated ("Custom", "Server
 * URL", "Connect", "Disconnect", "Connected", "Not connected", "Disconnected",
 * "Failed to connect", "Network error", "Unexpected server response", "Tips").
 *
 * The app translates by content: the English string is the key, so a locale
 * without an entry renders the key itself rather than a placeholder or a blank.
 * That is why only the locales that would otherwise read English are listed —
 * inventing translations for all 36 would be guesswork.
 */
const SERVER_TRANSLATIONS = {
  'zh-CN': {
    'Self-hosted': '自托管',
    'Connect the app to your own Readest server': '把应用连接到自建的 Readest 服务器',
    'Connected to {{url}}': '已连接到 {{url}}',
    'Supabase anon key (optional)': 'Supabase 匿名密钥（可选）',
    'Point the app at your own Readest server. Disconnecting returns to the official servers.':
      '把应用指向你自己的 Readest 服务器。断开连接即可回到官方服务器。',
  },
  'zh-TW': {
    'Self-hosted': '自架',
    'Connect the app to your own Readest server': '把應用連接到自架的 Readest 伺服器',
    'Connected to {{url}}': '已連線到 {{url}}',
    'Supabase anon key (optional)': 'Supabase 匿名金鑰（選填）',
    'Point the app at your own Readest server. Disconnecting returns to the official servers.':
      '把應用指向你自己的 Readest 伺服器。斷開連接即可回到官方伺服器。',
  },
};

function patchTranslations(root) {
  for (const [locale, entries] of Object.entries(SERVER_TRANSLATIONS)) {
    const file = path.join(
      root,
      'apps',
      'readest-app',
      'public',
      'locales',
      locale,
      'translation.json',
    );
    if (!existsSync(file)) {
      warn(`translations: ${locale} has no translation.json; skipping`);
      continue;
    }

    const raw = readFileSync(file, 'utf8');
    const missing = Object.entries(entries).filter(
      ([key]) => !raw.includes(JSON.stringify(key)),
    );
    if (missing.length === 0) {
      log(`translations: ${locale} already carries the server strings`);
      continue;
    }

    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);
    if (lines[0]?.trim() !== '{') {
      warn(`translations: ${locale}/translation.json does not open with '{'; skipping`);
      continue;
    }

    // The file is a flat key/value map whose order carries no meaning, so the
    // new entries go straight after the opening brace.
    lines.splice(
      1,
      0,
      ...missing.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`),
    );
    const patched = lines.join(eol);

    try {
      JSON.parse(patched);
    } catch (err) {
      warn(`translations: ${locale} would become invalid JSON (${err.message}); skipping`);
      continue;
    }

    writeFileSync(file, patched, 'utf8');
    log(`translations: ${locale} gained ${missing.length} server string(s)`);
  }
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

/* ------------------------------------- Android updater keys are per ABI, too */

/**
 * Upstream's Android updater asks for `android-arm64` on 64-bit ARM and for
 * `android-universal` on everything else. That only works while a universal APK
 * is published, and this project publishes one APK per ABI instead — so without
 * this patch, armeabi-v7a / x86_64 / x86 devices would be offered nothing at
 * all. The key is derived from the device arch, in one helper, so the nightly
 * path, the release check and the download window cannot drift apart.
 */
const ANDROID_KEY_HELPER = `/**
 * ${MARKER} One manifest key per Android ABI.
 *
 * Upstream derives it from "is this aarch64?", which needs a universal APK for
 * every other device. This build publishes one package per ABI, so the key comes
 * from the arch instead: arm64-v8a, armeabi-v7a, x86_64 and x86 each have their
 * own entry, and an arch with no package gets no update rather than a wrong one.
 */
export const getAndroidPlatformKey = (osArchVal: string): string | null => {
  switch (osArchVal) {
    case 'aarch64':
      return 'android-arm64';
    case 'arm':
      return 'android-armv7';
    case 'x86_64':
      return 'android-x86_64';
    case 'x86':
      return 'android-x86';
    default:
      return null;
  }
};

`;

const NIGHTLY_HELPER_ANCHOR = `export const getNightlyPlatformKey = (`;
const NIGHTLY_KEY_ANCHOR = `  if (osTypeVal === 'android')
    return osArchVal === 'aarch64' ? 'android-arm64' : 'android-universal';`;
const NIGHTLY_KEY_REPLACEMENT = `  if (osTypeVal === 'android') return getAndroidPlatformKey(osArchVal);`;

const ANDROID_CHECK_ANCHOR = `        if (
          isNewer &&
          ('android-arm64' in data.platforms || 'android-universal' in data.platforms)
        ) {`;
const ANDROID_CHECK_REPLACEMENT = `        // ${MARKER} Offer the update when this device's own ABI key is present,
        // rather than upstream's arm64-or-universal pair.
        const androidKey = getAndroidPlatformKey(osArch());
        if (isNewer && androidKey && androidKey in data.platforms) {`;

const WINDOW_IMPORT_ANCHOR = `import { setLastShownReleaseNotesVersion } from '@/helpers/updater';`;
const WINDOW_IMPORT_REPLACEMENT = `import { setLastShownReleaseNotesVersion, getAndroidPlatformKey } from '@/helpers/updater';`;

const WINDOW_KEY_ANCHOR = `        const OS_ARCH = osArch();
        const platformKey = OS_ARCH === 'aarch64' ? 'android-arm64' : 'android-universal';
        const arch = OS_ARCH === 'aarch64' ? 'arm64' : 'universal';`;
const WINDOW_KEY_REPLACEMENT = `        const OS_ARCH = osArch();
        // ${MARKER} The manifest carries one key per ABI, so every device is
        // offered the package built for it (upstream only knows arm64/universal).
        const platformKey = getAndroidPlatformKey(OS_ARCH);
        if (!platformKey) return;
        const arch = platformKey.replace('android-', '');`;

function patchAndroidUpdaterKeys(root) {
  const updaterFile = path.join(root, 'apps', 'readest-app', 'src', 'helpers', 'updater.ts');
  const { text: originalUpdater, eol: updaterEol } = readText(updaterFile);
  if (originalUpdater.includes('getAndroidPlatformKey')) {
    log('updater.ts: Android manifest keys already per ABI');
  } else {
    let updater = replaceOnce(
      originalUpdater,
      NIGHTLY_HELPER_ANCHOR,
      ANDROID_KEY_HELPER + NIGHTLY_HELPER_ANCHOR,
      'updater.ts/getAndroidPlatformKey',
    );
    updater = replaceOnce(updater, NIGHTLY_KEY_ANCHOR, NIGHTLY_KEY_REPLACEMENT, 'updater.ts/nightly key');
    updater = replaceOnce(updater, ANDROID_CHECK_ANCHOR, ANDROID_CHECK_REPLACEMENT, 'updater.ts/release check');
    writeText(updaterFile, updater, updaterEol);
    log('updater.ts: Android update keys are derived from the device ABI');
  }

  const windowFile = path.join(
    root,
    'apps',
    'readest-app',
    'src',
    'components',
    'UpdaterWindow.tsx',
  );
  const { text: originalWindow, eol: windowEol } = readText(windowFile);
  if (originalWindow.includes('getAndroidPlatformKey')) {
    log('UpdaterWindow.tsx: Android manifest key already per ABI');
  } else {
    let windowText = replaceOnce(
      originalWindow,
      WINDOW_IMPORT_ANCHOR,
      WINDOW_IMPORT_REPLACEMENT,
      'UpdaterWindow.tsx/import',
    );
    windowText = replaceOnce(windowText, WINDOW_KEY_ANCHOR, WINDOW_KEY_REPLACEMENT, 'UpdaterWindow.tsx/key');
    writeText(windowFile, windowText, windowEol);
    log('UpdaterWindow.tsx: downloads the package built for this device ABI');
  }
}

/* ------------------------------------------------------- build environment */

/**
 * Build-time variables written into both `.env.local` files.
 *
 * Their scopes, as measured on the built artifact rather than assumed:
 *
 *   - `NEXT_PUBLIC_SELF_HOSTED` / `SELF_HOSTED` reach `isSelfHosted()` in the
 *     shipped bundle — the public half is inlined as `"true"` in the chunks —
 *     which is the belt to the entitlement patch's braces.
 *   - `NEXT_PUBLIC_APP_PLATFORM` is already set by upstream's tracked
 *     `.env.tauri`, which `pnpm build` loads through `dotenv`. It is repeated
 *     here so that a build which must never resolve as the web app keeps that
 *     answer even if upstream drops the line.
 *   - the two `*_FIXED_QUOTA` values are read by `getServerRuntimeConfig()`,
 *     which only feeds the runtime config a *web* deployment injects into the
 *     page: `shouldInjectRuntimeConfig` is false for a tauri build, and
 *     `getStoragePlanData()` reads the unprefixed names anyway. They are inert
 *     in these artifacts. They stay because they are harmless and would matter
 *     again on a web deployment — the quotas themselves remain server-decided,
 *     as the README says.
 */
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
patchServerUrlSetting(root);
patchAndroidUpdaterKeys(root);
patchTranslations(root);
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
