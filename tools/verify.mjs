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
const SENTINEL_CONSTANTS = `// ${MARKER} Update endpoints and signing key are this project's.`;

const REPO = process.env['READEST_UNLOCKED_REPO'] ?? 'hirofumo/readest-unlocked';
const REPO_URL = `https://github.com/${REPO}`;
/**
 * The name the About dialog shows for this project. Derived the same way
 * unlock.mjs derives it — the repository's own name, not the `owner/name` slug —
 * so the assertion moves with READEST_UNLOCKED_REPO instead of pinning a label.
 */
const REPO_NAME = REPO.split('/').pop() ?? REPO;
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const RELEASE_DOWNLOAD_BASE = `${REPO_URL}/releases/latest/download`;
const UPDATER_MANIFEST_URL = `${RELEASE_DOWNLOAD_BASE}/latest.json`;
// Same source as unlock.mjs reads, so a key rotation moves both at once
// instead of silently disagreeing about which key was compiled in. `||` and not
// `??`: an unset GitHub variable arrives as an empty string.
const UPDATER_PUBKEY =
  process.env['READEST_UNLOCKED_UPDATER_PUBKEY'] ||
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
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  // The manifest paths have to stay *derived*. A value hardcoded to another
  // host would leave the base constant above in place, so checking that
  // constant alone would not notice an update path pointing somewhere else.
  //
  // The needle is deliberately the template-literal form, which is also what
  // tools/coexist.mjs rewrites to latest-coexist.json — so this holds for both
  // Android families rather than pinning one of them.
  if (normalized.includes(SENTINEL_CONSTANTS)) {
    ok('constants.ts carries the modification marker');
  } else {
    fail('constants.ts is missing the [readest-unlocked] modification marker');
  }

  const derivedPrefix = '`' + '${LATEST_DOWNLOAD_BASE_URL}/';
  for (const name of [
    'READEST_UPDATER_FILE',
    'READEST_CHANGELOG_FILE',
    'READEST_NIGHTLY_UPDATER_FILE',
  ]) {
    if (normalized.includes(`export const ${name} = ${derivedPrefix}`)) {
      ok(`${name} is derived from this project’s download base`);
    } else {
      fail(`${name} is not derived from LATEST_DOWNLOAD_BASE_URL; it could point at another host`);
    }
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

  // Both links name the project rather than the `owner/name` slug it lives
  // under. The old labels are asserted absent as well: a link that keeps its old
  // text is exactly what this build was changed to stop shipping.
  const labels = [
    { name: 'readest', href: 'https://github\\.com/readest/readest', text: 'readest' },
    { name: REPO_NAME, href: escapeRegExp(REPO_URL), text: escapeRegExp(REPO_NAME) },
  ];
  for (const { name, href, text } of labels) {
    const pattern = new RegExp(`<Link[^>]*href='${href}'[^>]*>\\s*${text}\\s*</Link>`);
    if (pattern.test(normalized)) ok(`AboutWindow shows the repository as "${name}"`);
    else fail(`AboutWindow does not show the repository as "${name}"`);
  }
  const staleLabels = [
    /<Link[^>]*>\s*github\.com\/readest\/readest\s*<\/Link>/,
    new RegExp(`<Link[^>]*>\\s*${escapeRegExp(REPO)}\\s*</Link>`),
  ];
  if (staleLabels.some((pattern) => pattern.test(normalized))) {
    fail('AboutWindow still shows an owner/name slug as link text');
  } else {
    ok('AboutWindow shows no owner/name slug as link text');
  }
}

/* 5. self-hosted server ----------------------------------------------------- */

const runtimeConfigFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'runtimeConfig.ts');
const runtimeConfig = read(runtimeConfigFile);
if (runtimeConfig === null) {
  fail(`missing ${runtimeConfigFile}`);
} else {
  const normalized = lf(runtimeConfig);
  const checks = [
    ['the runtime config type carries a node base URL', normalized.includes('nodeBaseUrl?: string;')],
    ['a configured server redirects the API base', normalized.includes('apiBaseUrl: url')],
    ['a configured server redirects the Node API', normalized.includes('nodeBaseUrl: url')],
    ['a configured server redirects the account backend', normalized.includes('supabaseUrl: url')],
    [
      'an optional Supabase anon key is honoured',
      normalized.includes('CUSTOM_SERVER_ANON_KEY') && normalized.includes('supabaseAnonKey: anonKey'),
    ],
    [
      'a disconnected server is ignored even though its address is kept',
      normalized.includes("CUSTOM_SERVER_ENABLED_KEY = 'readest.serverEnabled';") &&
        normalized.includes('!isCustomServerEnabled()'),
    ],
    [
      'an address stored before the switch existed still counts as enabled',
      normalized.includes("readStoredSetting(CUSTOM_SERVER_ENABLED_KEY) !== 'false'"),
    ],
  ];
  for (const [label, passed] of checks) {
    if (passed) ok(label);
    else fail(`runtimeConfig.ts: ${label}`);
  }
}

const environmentFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'environment.ts');
const environment = read(environmentFile);
if (environment === null) {
  fail(`missing ${environmentFile}`);
} else if (lf(environment).includes('getRuntimeConfig()?.nodeBaseUrl')) {
  ok('getNodeBaseUrl follows the configured server');
} else {
  fail('getNodeBaseUrl ignores the configured server, so Node endpoints still reach readest.com');
}

const deeplinkFile = path.join(root, 'apps', 'readest-app', 'src', 'utils', 'deeplink.ts');
const deeplink = read(deeplinkFile);
if (deeplink === null) {
  fail(`missing ${deeplinkFile}`);
} else if (lf(deeplink).includes('${getBaseUrl()}${ANNOTATION_PATH_PREFIX}')) {
  ok('annotation links follow the configured server');
} else {
  fail('annotation links are still built from the official web host');
}

const miscPanelFile = path.join(root, 'apps', 'readest-app', 'src', 'components', 'settings', 'MiscPanel.tsx');
const miscPanel = read(miscPanelFile);
if (miscPanel === null) {
  fail(`missing ${miscPanelFile}`);
} else {
  const normalized = lf(miscPanel);

  // The entry is a second-level page that mirrors the WebDAV panel: a row in the
  // Custom list pushes into a sub-page, which is a connect form until a server is
  // configured and the connected view with a Disconnect button afterwards.
  const entryChecks = [
    [
      'the Custom list carries a Self-hosted row',
      normalized.includes("data-setting-id='settings.custom.selfHosted'") &&
        normalized.includes('<NavigationRow'),
    ],
    ['the row title is translated', normalized.includes("title={_('Self-hosted')}")],
    [
      'the row reports whether a server is configured',
      normalized.includes("_('Connected')") && normalized.includes("_('Not connected')"),
    ],
    [
      'the sub-page is a breadcrumb off the Custom panel',
      normalized.includes('<SubPageHeader') &&
        normalized.includes("parentLabel={_('Custom')}") &&
        normalized.includes("currentLabel={_('Self-hosted')}"),
    ],
    [
      'the sub-page keeps the URL and anon-key fields',
      normalized.includes("htmlFor='selfHostedServerUrl'") && normalized.includes('draftAnonKey'),
    ],
    [
      'Android Back steps out of the sub-page',
      normalized.includes('useKeyDownActions') && normalized.includes('showSelfHosted'),
    ],
    [
      'the page switches between a connect form and a connected view',
      normalized.includes('isServerConfigured ? (') &&
        normalized.includes('const handleConnect = async () => {') &&
        normalized.includes('const handleDisconnect = () => {'),
    ],
    [
      'the connected state is the stored switch, not merely a stored address',
      normalized.includes('() => isCustomServerEnabled() && !!draftServerUrl'),
    ],
    [
      'the connected view names the server it talks to',
      normalized.includes("_('Connected to {{url}}', { url: draftServerUrl })"),
    ],
  ];
  for (const [label, passed] of entryChecks) {
    if (passed) ok(label);
    else fail(`MiscPanel.tsx: ${label}`);
  }

  // Connect is the WebDAV panel's button: filled, disabled until the URL is
  // there, spinning while the probe runs. Reset and the flat Apply are gone.
  if (normalized.includes("'btn btn-contrast'") && normalized.includes("_('Connect')")) {
    ok('Connect is the filled primary button');
  } else {
    fail('Connect is not the filled button this build ships');
  }
  if (normalized.includes('disabled={isConnecting || !draftServerUrl}')) {
    ok('Connect stays disabled until a URL is entered');
  } else {
    fail('Connect is not gated on a non-empty URL');
  }
  if (normalized.includes('loading loading-spinner loading-sm')) {
    ok('Connect shows the shared spinner while probing');
  } else {
    fail('Connect has no connecting state');
  }
  // The sub-page is where Connect/Disconnect live; the panel's CSS editors keep
  // their own Apply button, so the search is scoped to this block.
  const subPage = normalized.slice(
    normalized.indexOf('if (showSelfHosted) {'),
    normalized.indexOf('  return (\n    <div'),
  );
  if (subPage.includes("{_('Disconnect')}") && !subPage.includes("{_('Reset')}")) {
    ok('Reset is gone and Disconnect replaces it');
  } else {
    fail('MiscPanel.tsx must offer Disconnect instead of Reset');
  }
  if (!subPage.includes("_('Apply')")) {
    ok('the flat Apply button is gone from the self-hosted page');
  } else {
    fail('the self-hosted page still offers Apply');
  }

  // Connecting probes the origin before persisting, and reports both outcomes the
  // way the WebDAV panel does.
  const connect = normalized.slice(
    normalized.indexOf('const handleConnect = async () => {'),
    normalized.indexOf('const handleDisconnect'),
  );
  const probeChecks = [
    ['Connect probes the server first', normalized.includes('checkServerReachable(url)')],
    ['the probe uses the app’s own fetch helper', normalized.includes('fetchWithTimeout(')],
    [
      'a failed connect says why',
      connect.includes('_(\'Failed to connect\')') && connect.includes("type: 'error'"),
    ],
    [
      'the probe reports network failures and bad responses',
      normalized.includes("_('Network error')") &&
        normalized.includes("_('Unexpected server response (status {{status}})'"),
    ],
    [
      'the probe rejects anything that is not an http(s) URL',
      normalized.includes("_('Please enter a valid http(s) URL')") &&
        normalized.includes('target.protocol !=='),
    ],
    ['a successful connect is announced', connect.includes("_('Connected')")],
  ];
  for (const [label, passed] of probeChecks) {
    if (passed) ok(label);
    else fail(`MiscPanel.tsx: ${label}`);
  }

  // Disconnect keeps the WebDAV button's treatment and its credentials-survive
  // behaviour: only the switch goes off, the address stays, and the reload that
  // falls back to the official servers waits for the toast to paint.
  const disconnect = normalized.slice(normalized.indexOf('const handleDisconnect = () => {'));
  if (normalized.includes("'text-error hover:bg-error/10'")) {
    ok('Disconnect uses the WebDAV panel’s destructive treatment');
  } else {
    fail('Disconnect does not use the expected treatment');
  }
  if (
    disconnect.includes('storeServerSettings(draftServerUrl, draftAnonKey, false)') &&
    disconnect.includes('setIsServerConfigured(false)') &&
    disconnect.includes("_('Disconnected')")
  ) {
    ok('Disconnect keeps the address, flips the switch, then toasts');
  } else {
    fail('Disconnect does not keep the address / flip the switch / toast as expected');
  }
  if (
    normalized.includes('restartWithNotice') &&
    normalized.includes("eventDispatcher.dispatch('toast'") &&
    normalized.includes('window.location.reload()')
  ) {
    ok('Connect and Disconnect announce themselves before the reload');
  } else {
    fail('the reload does not announce itself first');
  }
  if (
    normalized.includes("'readest.serverUrl'") &&
    normalized.includes("'readest.supabaseAnonKey'") &&
    normalized.includes("'readest.serverEnabled'")
  ) {
    ok('the panel writes the storage keys the runtime config reads');
  } else {
    fail('the panel and runtimeConfig.ts disagree about the storage keys');
  }

  // The explanation is the canonical Tips callout now, not a bare paragraph.
  if (normalized.includes('<Tips>') && !normalized.includes('text-base-content/60 px-4 text-xs')) {
    ok('the explanation is a Tips callout');
  } else {
    fail('the self-hosted explanation is not the expected Tips callout');
  }

  // Every user-visible string has to go through _(), or the page ignores the
  // app's language entirely.
  const untranslated = [
    "title={_('Self-hosted')}",
    "currentLabel={_('Self-hosted')}",
    "description={_('Connect the app to your own Readest server')}",
    "'Connected to {{url}}'",
    "'Please enter a valid http(s) URL'",
    "_('Server URL')",
    "_('Supabase anon key (optional)')",
    "_('Connect')",
    "{_('Disconnect')}",
    "_('Failed to connect')",
    "_('Network error')",
  ].filter((needle) => !normalized.includes(needle));
  if (untranslated.length === 0) ok('every self-hosted string goes through the translation helper');
  else fail(`these self-hosted strings are not translated: ${untranslated.join(', ')}`);
}

// Both locales unlock.mjs writes, string by string. A locale that quietly fell
// back to the English key-as-content would otherwise pass unnoticed.
const TRANSLATED_LOCALES = {
  'zh-CN': [
    ['Self-hosted', '自托管'],
    ['Connect the app to your own Readest server', '把应用连接到自建的 Readest 服务器'],
    ['Connected to {{url}}', '已连接到 {{url}}'],
    ['Supabase anon key (optional)', 'Supabase 匿名密钥（可选）'],
    [
      'Point the app at your own Readest server. Disconnecting returns to the official servers.',
      '把应用指向你自己的 Readest 服务器。断开连接即可回到官方服务器。',
    ],
  ],
  'zh-TW': [
    ['Self-hosted', '自架'],
    ['Connect the app to your own Readest server', '把應用連接到自架的 Readest 伺服器'],
    ['Connected to {{url}}', '已連線到 {{url}}'],
    ['Supabase anon key (optional)', 'Supabase 匿名金鑰（選填）'],
    [
      'Point the app at your own Readest server. Disconnecting returns to the official servers.',
      '把應用指向你自己的 Readest 伺服器。斷開連接即可回到官方伺服器。',
    ],
  ],
};
for (const [locale, strings] of Object.entries(TRANSLATED_LOCALES)) {
  const file = path.join(root, 'apps', 'readest-app', 'public', 'locales', locale, 'translation.json');
  const content = read(file);
  if (content === null) {
    fail(`missing ${file}`);
    continue;
  }
  const missing = strings
    .filter(([key, value]) => !content.includes(`${JSON.stringify(key)}: ${JSON.stringify(value)}`))
    .map(([key]) => key);
  if (missing.length === 0) {
    ok(`the self-hosted strings are translated for ${locale}`);
  } else {
    fail(`${locale} has no translation for: ${missing.join(' | ')}`);
  }
}

/* 6. build environment ------------------------------------------------------ */

// The keys unlock.mjs writes and the value each has to hold. `SELF_HOSTED` and
// its public twin are what `isSelfHosted()` falls back to inside the shipped
// bundle; `NEXT_PUBLIC_APP_PLATFORM` keeps a build from ever resolving as the
// web app if upstream drops the line from its tracked `.env.tauri`.
//
// The two `*_FIXED_QUOTA` values are deliberately not asserted: they are inert
// in these artifacts (see the note on ENV_VARS in unlock.mjs), and asserting
// them would freeze a setting that does nothing.
const EXPECTED_ENV = {
  NEXT_PUBLIC_APP_PLATFORM: 'tauri',
  NEXT_PUBLIC_SELF_HOSTED: 'true',
  SELF_HOSTED: 'true',
};

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
  for (const [key, expected] of Object.entries(EXPECTED_ENV)) {
    if (vars[key] === expected) ok(`${rel} sets ${key}=${expected}`);
    else fail(`${rel} sets ${key}=${vars[key] ?? '(unset)'}, expected ${expected}`);
  }
}

/* 7. cosmetic patches (warnings only) --------------------------------------- */

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

/* 8. Android update keys (one per ABI) --------------------------------------- */

const updaterFile = path.join(root, 'apps', 'readest-app', 'src', 'helpers', 'updater.ts');
const updaterSrc = read(updaterFile);
if (updaterSrc === null) {
  fail(`missing ${updaterFile}`);
} else {
  const text = lf(updaterSrc);

  if (text.includes('export const getAndroidPlatformKey')) {
    ok('updater.ts derives the Android manifest key from the device ABI');
  } else {
    fail('updater.ts has no getAndroidPlatformKey helper');
  }

  const ANDROID_KEY_MAP = [
    ['aarch64', 'android-arm64'],
    ['arm', 'android-armv7'],
    ['x86_64', 'android-x86_64'],
    ['x86', 'android-x86'],
  ];
  for (const [arch, key] of ANDROID_KEY_MAP) {
    if (new RegExp(`case '${arch}':\\s*\\n\\s*return '${key}';`).test(text)) {
      ok(`the Android key helper maps ${arch} to ${key}`);
    } else {
      fail(`the Android key helper does not map ${arch} to ${key}`);
    }
  }

  if (text.includes('return getAndroidPlatformKey(osArchVal);')) {
    ok('the nightly channel uses the per-ABI key');
  } else {
    fail('the nightly channel does not use the per-ABI key');
  }

  if (text.includes('androidKey in data.platforms')) {
    ok('the Android release check looks for this device’s ABI');
  } else {
    fail('the Android release check does not look for this device’s ABI');
  }

  if (text.includes('android-universal')) {
    fail("updater.ts still asks for 'android-universal', which this project no longer publishes");
  } else {
    ok('updater.ts asks for no Android key this project stopped publishing');
  }
}

const updaterWindowFile = path.join(
  root,
  'apps',
  'readest-app',
  'src',
  'components',
  'UpdaterWindow.tsx',
);
const updaterWindowSrc = read(updaterWindowFile);
if (updaterWindowSrc === null) {
  fail(`missing ${updaterWindowFile}`);
} else {
  const text = lf(updaterWindowSrc);
  if (text.includes('getAndroidPlatformKey(OS_ARCH)')) {
    ok('the update window downloads the package for this device ABI');
  } else {
    fail('the update window does not resolve the package from the device ABI');
  }
  if (text.includes('android-universal')) {
    fail("UpdaterWindow.tsx still asks for 'android-universal'");
  } else {
    ok('UpdaterWindow.tsx asks for no Android key this project stopped publishing');
  }
}

/* summary ------------------------------------------------------------------- */

console.log('');
if (failures.length) {
  console.error(`[verify] FAILED with ${failures.length} problem(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('[verify] all checks passed: this checkout builds unlocked and updates from this project');
