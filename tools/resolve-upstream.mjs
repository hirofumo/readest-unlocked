#!/usr/bin/env node
/**
 * Resolves which upstream Readest build to produce next.
 *
 * Called from the `detect` job. Reads its inputs from the environment so the
 * workflow does not have to inline any API plumbing:
 *
 *   INPUT_NIGHTLY    "true" resolves upstream `main` for the daily pre-release
 *   INPUT_REF          workflow_dispatch ref override (tag, branch or sha)
 *   INPUT_FORCE        "true" rebuilds even when the build already exists
 *   HAS_ANDROID_KEY    "false" means the Android legs will not run, so their
 *                      assets are not part of this run's contract
 *   GH_TOKEN           optional; raises the GitHub API rate limit
 *   GITHUB_REPOSITORY  owner/repo publishing the releases
 *
 * Two release identities come out of here:
 *
 *   release   — tag `v<version>`, assets `Readest-<version>-...`. This is the
 *               numbered release, and it is the build the in-app updater follows.
 *   nightly — tag `NightlyBuild`, assets `Readest-<date>-<short sha>-...`, marked
 *               as a pre-release. It is built from upstream `main` every day and
 *               publishes its own `nightly.json`, never `latest.json`.
 *
 * The upstream commit is resolved once, here, and every job checks that exact
 * SHA out — so the short hash in the asset names, the provenance file and the
 * compiled code all describe the same commit even if upstream moves mid-run.
 *
 * Writes build/mode/ref/version/tag/asset_prefix/manifest_version/date/...
 * to $GITHUB_OUTPUT (and to stdout).
 */

const UPSTREAM = process.env['UPSTREAM_REPO'] ?? 'readest/readest';
import { missingAssets } from './release-assets.mjs';

const SELF = process.env['GITHUB_REPOSITORY'] ?? '';
const TOKEN = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
const INPUT_REF = (process.env['INPUT_REF'] ?? '').trim();
const NIGHTLY = ['true', '1', 'yes'].includes((process.env['INPUT_NIGHTLY'] ?? '').toLowerCase());
const FORCE = ['true', '1', 'yes'].includes((process.env['INPUT_FORCE'] ?? '').toLowerCase());
// The `detect` job materialises the Android secret's presence as this boolean
// string. A fork without it never runs those legs, so their assets are not part
// of that fork's contract — expecting them would make every run look incomplete
// and rebuild forever. Absent means "assume yes": the workflow always sets it,
// and a silent default of "no" would quietly shrink the contract.
const ANDROID = (process.env['HAS_ANDROID_KEY'] ?? 'true') !== 'false';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'readest-unlocked-build',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};
async function get(url) {
  const res = await fetch(url, { headers });
  return res;
}

function die(message) {
  console.error(`[resolve] ERROR: ${message}`);
  process.exit(1);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/* 1. Which upstream ref? ---------------------------------------------------- */

let upstreamTag = '';
let ref = INPUT_REF;

if (!ref) {
  if (NIGHTLY) {
    ref = 'main';
  } else {
    const res = await get(`https://api.github.com/repos/${UPSTREAM}/releases/latest`);
    if (res.status === 404) {
      die(`${UPSTREAM} has no published release; pass an explicit ref instead.`);
    }
    if (!res.ok) {
      die(`could not read ${UPSTREAM} releases/latest: HTTP ${res.status} ${res.statusText}`);
    }
    const release = await res.json();
    upstreamTag = release.tag_name;
    ref = upstreamTag;
    if (!ref) die(`${UPSTREAM} releases/latest returned no tag_name`);
  }
}

/* 2. Which upstream commit is that? ----------------------------------------- */

// Resolved to a commit, not left as a branch name: `main` moves, and the asset
// hash, the BUILD.md provenance and the checked-out tree must not disagree.
const commitRes = await get(`https://api.github.com/repos/${UPSTREAM}/commits/${encodeURIComponent(ref)}`);
if (!commitRes.ok) {
  die(`could not resolve upstream commit for ref ${ref}: HTTP ${commitRes.status} ${commitRes.statusText}`);
}
const commit = await commitRes.json();
const upstreamSha = commit.sha ?? '';
if (!upstreamSha) die(`${UPSTREAM} returned no commit sha for ${ref}`);
const shortSha = upstreamSha.slice(0, 7);

/* 3. Which version is that? ------------------------------------------------- */

let version = '';
const pkgRes = await get(
  `https://raw.githubusercontent.com/${UPSTREAM}/${upstreamSha}/apps/readest-app/package.json`,
);
if (pkgRes.ok) {
  try {
    version = JSON.parse(await pkgRes.text()).version ?? '';
  } catch {
    version = '';
  }
}
if (!version) {
  // Fall back to the tag itself: upstream tags are v<version>.
  const stripped = ref.replace(/^v/, '');
  if (/^\d+\.\d+\.\d+/.test(stripped)) {
    version = stripped;
    console.log(`[resolve] package.json unavailable at ${ref}; using the tag as the version`);
  } else {
    die(`could not determine a version for ref ${ref}`);
  }
}

/* 4. Identity of this build ------------------------------------------------- */

const now = new Date();
const date = `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
// A nightly version is `<base>-<YYYYMMDDHH>`: the app's comparator treats a
// nightly on the same base as newer than the numbered release it follows.
const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
const manifestVersion = NIGHTLY ? `${version}-${stamp}` : version;
const tag = NIGHTLY ? 'NightlyBuild' : `v${version}`;
const assetPrefix = NIGHTLY ? `Readest-${date}-${shortSha}` : `Readest-${version}`;

/* 5. Is it already built? --------------------------------------------------- */

let build = true;
if (FORCE) {
  console.log('[resolve] force requested: rebuilding regardless of existing releases');
} else if (!SELF) {
  console.log('[resolve] GITHUB_REPOSITORY is unset: assuming a rebuild is needed');
} else if (NIGHTLY) {
  // The rolling pre-release keeps only the latest build. Its assets are the
  // only record of which upstream commit is current, so the commit is the
  // "already built" test: `Readest-<date>-<sha>-...` assets mean this exact
  // tree is already published.
  //
  // The commit alone is not enough, though. A leg that failed leaves its asset
  // absent, and the release then keeps that gap forever: on 2026-10-31 the
  // NightlyBuild release held 41 of its 42 assets (no IPA) and this check still
  // answered "already carries <sha>; nothing to do" on every scheduled run —
  // recovering took a manual `force=true`. So the release has to hold the whole
  // contract, not just one asset with the right prefix.
  const res = await get(`https://api.github.com/repos/${SELF}/releases/tags/${tag}`);
  if (res.status === 200) {
    const release = await res.json();
    const names = (release.assets ?? []).map((asset) => asset.name);
    // The date in the asset names is the day the build ran, not today: when
    // upstream `main` has not moved, yesterday's build is the current one. Read
    // the prefix back out of the assets instead of assuming `date` (which is
    // today), or every unchanged day would look like a release missing every
    // file and rebuild the whole matrix.
    const pattern = new RegExp(`^(Readest-\\d{4}\\.\\d{2}\\.\\d{2}-${shortSha})-`);
    const carried = names.map((name) => pattern.exec(name)).find(Boolean);
    if (!carried) {
      console.log(`[resolve] ${tag} does not carry ${shortSha} yet; building it`);
      build = true;
    } else {
      // Same contract the `manifest` job asserts, read from the same module so
      // the two cannot disagree about what a complete release looks like.
      const existingPrefix = carried[1];
      const missing = missingAssets({
        mode: 'nightly',
        prefix: existingPrefix,
        android: ANDROID,
        actual: names,
      });
      build = missing.length > 0;
      console.log(
        missing.length
          ? `[resolve] ${tag} carries ${shortSha} but is short ${missing.length} asset(s); rebuilding:\n` +
              `  ${missing.join('\n  ')}`
          : `[resolve] ${tag} already carries ${shortSha} (${existingPrefix}) with every asset; nothing to do`,
      );
    }
  } else if (res.status === 404) {
    build = true;
  } else {
    console.log(`[resolve] could not check ${tag} (HTTP ${res.status}); building anyway`);
    build = true;
  }
} else {
  // Numbered releases, same reasoning as the nightly branch above: a version
  // published by a run whose iOS leg failed is missing its IPA, and "the tag
  // exists" alone would then skip that version forever. Rebuilding is safe and
  // intended — the release tag follows the newest build of the version (§7) —
  // and the daily 03:00 run retries until the release holds the whole contract.
  //
  // Only the current-scheme tag is held to the contract. `v<version>-unlocked`
  // is the pre-rename identity, kept working so old links do not break; its
  // asset names predate this contract, so judging it by that contract would
  // rebuild a release that is complete and unreachable by the updater anyway.
  let published = false;
  for (const candidate of [`v${version}`, `v${version}-unlocked`]) {
    const res = await get(`https://api.github.com/repos/${SELF}/releases/tags/${candidate}`);
    if (res.status === 404) continue;
    if (res.status !== 200) {
      console.log(`[resolve] could not check ${candidate} (HTTP ${res.status}); building anyway`);
      continue;
    }
    if (candidate !== `v${version}`) {
      published = true;
      console.log(`[resolve] ${candidate} already exists (pre-rename tag); nothing to do`);
      break;
    }
    const names = ((await res.json()).assets ?? []).map((asset) => asset.name);
    const missing = missingAssets({ mode: 'release', prefix: assetPrefix, android: ANDROID, actual: names });
    published = missing.length === 0;
    console.log(
      missing.length
        ? `[resolve] ${candidate} exists but is short ${missing.length} asset(s); rebuilding:\n` +
            `  ${missing.join('\n  ')}`
        : `[resolve] ${candidate} already exists with every asset; nothing to do`,
    );
    if (!missing.length) break;
  }
  build = !published;
}

/* 6. Coexisting Android identity -------------------------------------------- */

// Fork-friendly: the coexisting family's application id defaults to the
// repository owner, so a fork does not collide with this project's package.
// The repository variable READEST_COEXIST_IDENTIFIER overrides it.
const OWNER = (process.env['GITHUB_REPOSITORY_OWNER'] ?? '').trim();
const OWNER_LABEL = OWNER.toLowerCase().replace(/[^a-z0-9]/g, '');
const DEFAULT_COEXIST_IDENTIFIER = OWNER_LABEL
  ? `com.${OWNER_LABEL}.readest.unlocked`
  : 'com.hirofumo.readest.unlocked';
const coexistIdentifier =
  (process.env['COEXIST_IDENTIFIER'] ?? '').trim() || DEFAULT_COEXIST_IDENTIFIER;

/* 7. Report ----------------------------------------------------------------- */

console.log(`[resolve] mode          : ${NIGHTLY ? 'nightly' : 'release'}`);
console.log(`[resolve] upstream ref  : ${ref}${upstreamTag ? ' (latest release)' : ''}`);
console.log(`[resolve] upstream sha  : ${upstreamSha} (${shortSha})`);
console.log(`[resolve] version       : ${version}`);
console.log(`[resolve] release tag   : ${tag}`);
console.log(`[resolve] asset prefix  : ${assetPrefix}`);
console.log(`[resolve] coexisting id : ${coexistIdentifier}`);
console.log(`[resolve] build         : ${build}`);

const outputs = {
  build: String(build),
  mode: NIGHTLY ? 'nightly' : 'release',
  ref,
  version,
  tag,
  asset_prefix: assetPrefix,
  coexist_identifier: coexistIdentifier,
  manifest_version: manifestVersion,
  date: NIGHTLY ? date : '',
  short_sha: shortSha,
  upstream_sha: upstreamSha,
  prerelease: String(NIGHTLY),
  upstream_tag: upstreamTag,
};
const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(outputFile, `${lines}\n`, 'utf8');
}
