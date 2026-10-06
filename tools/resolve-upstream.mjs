#!/usr/bin/env node
/**
 * Resolves which upstream Readest build to produce next.
 *
 * Called from the `detect` job. Reads its inputs from the environment so the
 * workflow does not have to inline any API plumbing:
 *
 *   INPUT_REF          workflow_dispatch ref override (tag / branch / sha)
 *   INPUT_FORCE        "true" rebuilds even when the release already exists
 *   GH_TOKEN           optional; raises the GitHub API rate limit
 *   GITHUB_REPOSITORY  owner/repo publishing the releases
 *
 * Writes build/ref/version/tag to $GITHUB_OUTPUT (and to stdout).
 */

const UPSTREAM = process.env['UPSTREAM_REPO'] ?? 'readest/readest';
const SELF = process.env['GITHUB_REPOSITORY'] ?? '';
const TOKEN = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
const INPUT_REF = (process.env['INPUT_REF'] ?? '').trim();
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

/* 1. Which upstream ref? ---------------------------------------------------- */

let upstreamTag = '';
let ref = INPUT_REF;

if (!ref) {
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

/* 2. Which version is that? ------------------------------------------------- */

let version = '';
const pkgRes = await get(
  `https://raw.githubusercontent.com/${UPSTREAM}/${encodeURIComponent(ref)}/apps/readest-app/package.json`,
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

const tag = `v${version}-unlocked`;

/* 3. Is it already built? --------------------------------------------------- */

let build = true;
if (FORCE) {
  console.log('[resolve] force requested: rebuilding regardless of existing releases');
} else if (!SELF) {
  console.log('[resolve] GITHUB_REPOSITORY is unset: assuming a rebuild is needed');
} else {
  const res = await get(`https://api.github.com/repos/${SELF}/releases/tags/${tag}`);
  if (res.status === 200) {
    build = false;
    console.log(`[resolve] ${tag} already exists; nothing to do`);
  } else if (res.status === 404) {
    build = true;
  } else {
    console.log(`[resolve] could not check ${tag} (HTTP ${res.status}); building anyway`);
    build = true;
  }
}

/* 4. Report ----------------------------------------------------------------- */

console.log(`[resolve] upstream ref : ${ref}${upstreamTag ? ` (latest release)` : ''}`);
console.log(`[resolve] version      : ${version}`);
console.log(`[resolve] release tag  : ${tag}`);
console.log(`[resolve] build        : ${build}`);

const outputs = { build: String(build), ref, version, tag, upstream_tag: upstreamTag };
const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(outputFile, `${lines}\n`, 'utf8');
}
