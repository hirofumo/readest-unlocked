#!/usr/bin/env node
/**
 * Resolves which upstream Readest build to produce next.
 *
 * Called from the `detect` job. Reads its inputs from the environment so the
 * workflow does not have to inline any API plumbing:
 *
 *   INPUT_AUTOBUILD    "true" resolves upstream `main` for the daily pre-release
 *   INPUT_REF          workflow_dispatch ref override (tag, branch or sha)
 *   INPUT_FORCE        "true" rebuilds even when the build already exists
 *   GH_TOKEN           optional; raises the GitHub API rate limit
 *   GITHUB_REPOSITORY  owner/repo publishing the releases
 *
 * Two release identities come out of here:
 *
 *   release   — tag `v<version>`, assets `Readest-<version>-...`. This is the
 *               numbered release, and it is the build the in-app updater follows.
 *   autobuild — tag `AutoBuild`, assets `Readest-<date>-<short sha>-...`, marked
 *               as a pre-release. It is built from upstream `main` every day and
 *               publishes its own `latest-autobuild*.json`, never `latest.json`.
 *
 * The upstream commit is resolved once, here, and every job checks that exact
 * SHA out — so the short hash in the asset names, the provenance file and the
 * compiled code all describe the same commit even if upstream moves mid-run.
 *
 * Writes build/mode/ref/version/tag/asset_prefix/manifest_version/date/...
 * to $GITHUB_OUTPUT (and to stdout).
 */

const UPSTREAM = process.env['UPSTREAM_REPO'] ?? 'readest/readest';
const SELF = process.env['GITHUB_REPOSITORY'] ?? '';
const TOKEN = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
const INPUT_REF = (process.env['INPUT_REF'] ?? '').trim();
const AUTOBUILD = ['true', '1', 'yes'].includes((process.env['INPUT_AUTOBUILD'] ?? '').toLowerCase());
const FORCE = ['true', '1', 'yes'].includes((process.env['INPUT_FORCE'] ?? '').toLowerCase());

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
  if (AUTOBUILD) {
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
// The updater compares versions as semver, so the autobuild manifest needs a
// monotonic dotted version of its own: 2026.1.1, not 2026.01.01 (leading zeros
// are illegal in semver).
const manifestVersion = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
const tag = AUTOBUILD ? 'AutoBuild' : `v${version}`;
const assetPrefix = AUTOBUILD ? `Readest-${date}-${shortSha}` : `Readest-${version}`;

/* 5. Is it already built? --------------------------------------------------- */

let build = true;
if (FORCE) {
  console.log('[resolve] force requested: rebuilding regardless of existing releases');
} else if (!SELF) {
  console.log('[resolve] GITHUB_REPOSITORY is unset: assuming a rebuild is needed');
} else if (AUTOBUILD) {
  // The rolling pre-release keeps only the latest build. Its assets are the
  // only record of which upstream commit is current, so the commit itself is
  // the "already built" test: any `Readest-<date>-<sha>-...` asset means this
  // exact tree is already published.
  const res = await get(`https://api.github.com/repos/${SELF}/releases/tags/${tag}`);
  if (res.status === 200) {
    const release = await res.json();
    const pattern = new RegExp(`^Readest-\\d{4}\\.\\d{2}\\.\\d{2}-${shortSha}-`);
    const present = (release.assets ?? []).some((asset) => pattern.test(asset.name));
    build = !present;
    console.log(
      present
        ? `[resolve] ${tag} already carries ${shortSha}; nothing to do`
        : `[resolve] ${tag} does not carry ${shortSha} yet; building it`,
    );
  } else if (res.status === 404) {
    build = true;
  } else {
    console.log(`[resolve] could not check ${tag} (HTTP ${res.status}); building anyway`);
    build = true;
  }
} else {
  // A version published before the rename still lives under the old tag. Treat
  // it as published: renaming history would break every link to it, and the new
  // scheme only needs to hold from the next upstream version on.
  let published = false;
  for (const candidate of [`v${version}`, `v${version}-unlocked`]) {
    const res = await get(`https://api.github.com/repos/${SELF}/releases/tags/${candidate}`);
    if (res.status === 200) {
      published = true;
      console.log(`[resolve] ${candidate} already exists; nothing to do`);
      break;
    }
    if (res.status !== 404) {
      console.log(`[resolve] could not check ${candidate} (HTTP ${res.status}); building anyway`);
    }
  }
  build = !published;
}

/* 6. Report ----------------------------------------------------------------- */

console.log(`[resolve] mode          : ${AUTOBUILD ? 'autobuild' : 'release'}`);
console.log(`[resolve] upstream ref  : ${ref}${upstreamTag ? ' (latest release)' : ''}`);
console.log(`[resolve] upstream sha  : ${upstreamSha} (${shortSha})`);
console.log(`[resolve] version       : ${version}`);
console.log(`[resolve] release tag   : ${tag}`);
console.log(`[resolve] asset prefix  : ${assetPrefix}`);
console.log(`[resolve] build         : ${build}`);

const outputs = {
  build: String(build),
  mode: AUTOBUILD ? 'autobuild' : 'release',
  ref,
  version,
  tag,
  asset_prefix: assetPrefix,
  manifest_version: manifestVersion,
  date: AUTOBUILD ? date : '',
  short_sha: shortSha,
  upstream_sha: upstreamSha,
  prerelease: String(AUTOBUILD),
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
