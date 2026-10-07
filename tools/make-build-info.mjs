#!/usr/bin/env node
/**
 * Writes the `BUILD.md` published with a release.
 *
 * `unlock.patch` shows *what* changed; this file says *what it was built from*
 * and *how it was checked*, in one place a person can read without opening any
 * script. It is deliberately additive: if a field cannot be filled in, it says
 * so rather than guessing.
 *
 * The build-time variables are read out of `tools/unlock.mjs`'s `ENV_VARS`
 * block instead of being repeated here, so the two cannot drift apart.
 *
 * Usage:
 *   node tools/make-build-info.mjs --out BUILD.md \
 *     --upstream-repo readest/readest --upstream-ref v0.12.12 --upstream-sha <sha> \
 *     --recipe-repo hirofumo/readest-unlocked --recipe-sha <sha> \
 *     --tag v0.12.12-unlocked --version 0.12.12 --changed-files <n> \
 *     [--run-url <url>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`\n[build-info] ERROR: ${message}\n`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[build-info] WARNING: ${message}`);
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const outFile = path.resolve(arg('out', 'BUILD.md'));
const upstreamRepo = arg('upstream-repo');
const upstreamRef = arg('upstream-ref');
const upstreamSha = arg('upstream-sha');
const recipeRepo = arg('recipe-repo');
const recipeSha = arg('recipe-sha');
const tag = arg('tag');
const version = arg('version');
const changedFiles = arg('changed-files');
const runUrl = arg('run-url');

for (const [name, value] of Object.entries({
  'upstream-repo': upstreamRepo,
  'upstream-ref': upstreamRef,
  'upstream-sha': upstreamSha,
  'recipe-repo': recipeRepo,
  'recipe-sha': recipeSha,
  tag,
  version,
})) {
  if (!value) fail(`--${name} is required`);
}

/* ----------------------------------- build-time variables, read from source */

const recipeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let envVars = [];
try {
  const unlock = readFileSync(path.join(recipeRoot, 'tools', 'unlock.mjs'), 'utf8');
  const block = unlock.match(/const ENV_VARS = \{([\s\S]*?)\};/);
  if (block) envVars = [...block[1].matchAll(/^\s*([A-Z0-9_]+)\s*:/gm)].map((m) => m[1]);
} catch (err) {
  warn(`could not read tools/unlock.mjs: ${err.message}`);
}
if (envVars.length === 0) {
  warn('could not extract ENV_VARS from tools/unlock.mjs; the list will be omitted');
}

const short = (sha) => (sha.length === 40 ? sha.slice(0, 12) : sha);
const link = (repo, sha) => `[\`${short(sha)}\`](https://github.com/${repo}/commit/${sha})`;

const lines = [
  `# Build provenance — ${tag}`,
  '',
  'This is an **unofficial, modified** build of Readest. It is not produced,',
  'endorsed or supported by Readest or Bilingify LLC. Everything needed to audit',
  'or reproduce it is below.',
  '',
  '## What it was built from',
  '',
  '| | |',
  '| --- | --- |',
  `| Upstream | [\`${upstreamRepo}@${upstreamRef}\`](https://github.com/${upstreamRepo}/tree/${upstreamRef}) |`,
  `| Upstream commit | ${link(upstreamRepo, upstreamSha)} |`,
  `| Build recipe | ${link(recipeRepo, recipeSha)} |`,
  `| Version | ${version} |`,
  ...(runUrl ? [`| Workflow run | [\`${runUrl.split('/').pop()}\`](${runUrl}) |`] : []),
  '',
  '## What was changed',
  '',
  `\`unlock.patch\`, next to this file, is the complete diff between the upstream`,
  `commit above and the sources this release was compiled from${changedFiles ? ` — ${changedFiles} file(s)` : ''}.`,
  'No other source file is touched, and nothing is patched at runtime.',
  '',
  'The diff does **not** include `apps/readest-app/.env.local`: that file is',
  'gitignored upstream, so it can never appear in a diff. The build writes these',
  'build-time variables into it —',
  '',
  ...(envVars.length
    ? envVars.map((v) => `- \`${v}\``)
    : ['- _(could not be read from `tools/unlock.mjs` at build time — see that file)_']),
  '',
  '— and `tools/unlock.mjs` documents what each one does and which of them',
  'actually take effect in a Tauri build.',
  '',
  '## How it was checked',
  '',
  'Three layers, none of them a stronger claim than what it actually checks:',
  '',
  '1. **Source assertions.** `tools/verify.mjs` runs after the patch and before',
  '   the native build, and fails the leg when any assertion does not hold.',
  '2. **The built artifact.** `tools/check-bundle.mjs` asserts the',
  '   `__READEST_UNLOCKED__` marker against the JavaScript the app actually',
  '   ships, and each Android APK has its `applicationId` and its signing',
  '   certificate checked at the artifact level (not from its name or size).',
  '3. **Signatures.** Every updatable artifact carries a minisign signature,',
  '   verified against the public key compiled into the app.',
  '',
  '## Verifying the download',
  '',
  '```bash',
  `gh release download ${tag} --repo ${recipeRepo} --pattern 'Readest-*' --pattern 'SHA256SUMS'`,
  'sha256sum -c SHA256SUMS          # or: shasum -a 256 -c SHA256SUMS',
  '```',
  '',
  'A matching checksum proves the file arrived intact; it does not prove where it',
  'came from. For that, ask GitHub for the build provenance attestation:',
  '',
  '```bash',
  `gh attestation verify Readest-${version}-windows-x64-setup.exe --repo ${recipeRepo}`,
  '```',
  '',
  'That succeeds only if the file was produced by a workflow run in this',
  'repository, and it prints which commit and which workflow produced it. It is',
  'not a statement that the code is trustworthy — for that, read',
  '`unlock.patch` above.',
  '',
  '## License',
  '',
  'Readest is licensed under **AGPL-3.0**, and so are these builds and the',
  'scripts that produce them. The corresponding source is this repository at the',
  `build-recipe commit above, plus the upstream tree at the upstream commit above.`,
  '',
];

writeFileSync(outFile, `${lines.join('\n')}`, 'utf8');
console.log(
  `[build-info] wrote ${path.basename(outFile)} for ${tag}: ` +
    `${upstreamRepo}@${short(upstreamSha)} + ${recipeRepo}@${short(recipeSha)}` +
    `${envVars.length ? `, ${envVars.length} env var(s)` : ''}`,
);
