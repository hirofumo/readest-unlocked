#!/usr/bin/env node
/**
 * Asserts the build workflow installs the system packages the upstream tree
 * actually needs to compile on Linux.
 *
 * Why this exists: the recipe's Linux legs compile the same sources upstream
 * does, but they install their own dependency list. On 2026-11-03 upstream's
 * "play local AAC narration natively on Linux" (#7240) linked CPAL into the
 * native TTS plugin; CPAL's `alsa-sys` build script asks pkg-config for
 * `alsa.pc` and *panics* when it is missing. Upstream's CI grew
 * `libasound2-dev libclang-dev g++` in the same commit — this workflow did not,
 * and both Linux legs died 40 minutes into a Nightly Build at `alsa-sys`.
 * Nothing else in the pipeline notices: the crate is only compiled on Linux, so
 * the failure costs a whole run every time it is rediscovered.
 *
 * The check reads the crates in the upstream checkout's `Cargo.lock` (the honest
 * answer for transitive crates — nothing declares `alsa-sys` directly, it
 * arrives under CPAL), maps the ones with a known build-time system dependency
 * to the package that provides it, and requires the workflow's apt line to name
 * every one. It is deliberately a **map of known crates**, not a parser of build
 * scripts: a Rust build script can look for anything, and guessing would either
 * produce false failures or a check nobody trusts. A crate that gains a new
 * system dependency is added here, in the same commit as the package — the same
 * discipline as `release-assets.mjs` and the `verify.mjs` assertions.
 *
 * Usage:
 *   node tools/check-linux-deps.mjs [--root <upstream-checkout>] [--workflow <path>]
 *
 * Run from a directory containing the upstream tree, or name it with --root.
 * The workflow defaults to the one in this repository, found relative to this
 * script, so the check also works from inside a preflight job where the current
 * directory is the upstream checkout.
 *
 * Exits non-zero and names the missing package(s) and the crate that needs them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Crates that need a system package to *build* on Linux. Each entry carries the
 * reason, because the reason is the only thing that makes a future failure
 * diagnosable. `packages` is a list: one crate can need more than one.
 */
const SYSTEM_DEPS = {
  'alsa-sys': [
    {
      package: 'libasound2-dev',
      why: 'its build script asks pkg-config for `alsa.pc` and panics when it is absent',
    },
  ],
  'soundtouch-ffi': [
    {
      package: 'libclang-dev',
      why: 'its bundled C++ build runs bindgen, which needs libclang',
    },
    {
      package: 'g++',
      why: 'its bundled C++ build compiles SoundTouch through cc, which needs a C++ compiler',
    },
  ],
};

/** The apt line that installs the Linux build dependencies, found by its shape. */
const LINUX_INSTALL =
  /^\s*sudo apt-get install -y .*\bpkg-config\b.*\blibgtk-3-dev\b/;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) {
    console.error(`[linux-deps] ERROR: --${name} requires a value`);
    process.exit(1);
  }
  return value;
};

const root = path.resolve(arg('root', process.env['READEST_ROOT'] ?? process.cwd()));
const workflow = path.resolve(
  arg('workflow', path.join(scriptDir, '..', '.github', 'workflows', 'build-unlocked.yml')),
);

for (const [label, target] of [
  ['upstream checkout', root],
  ['workflow', workflow],
]) {
  if (!existsSync(target)) {
    console.error(`[linux-deps] ERROR: ${label} ${target} does not exist`);
    process.exit(1);
  }
}

/* What does this checkout need? ----------------------------------------- */

// Upstream keeps two resolutions: `Cargo.lock` (the wry graph every platform but
// Linux-CEF builds) and `Cargo.cef.lock` (the CEF graph this recipe's Linux legs
// actually compile — `apps/readest-app/scripts/tauri.mjs` swaps it in as
// Cargo.lock for the duration of the build). A crate in either one is compiled
// here, so the packages are the union of both.
const lockPaths = readdirSync(root)
  .filter((entry) => /^Cargo(\.[A-Za-z0-9_-]+)?\.lock$/.test(entry))
  .map((entry) => path.join(root, entry));
const present = new Set();
if (lockPaths.length > 0) {
  for (const lockPath of lockPaths) {
    for (const match of readFileSync(lockPath, 'utf8').matchAll(/^name = "([^"]+)"$/gm)) {
      present.add(match[1]);
    }
    console.log(`[linux-deps] read ${path.basename(lockPath)}`);
  }
} else {
  // A lock file is what makes transitive crates visible. Without one this can
  // only see direct declarations, which is exactly the case that missed
  // `alsa-sys` in the first place — say so instead of passing quietly.
  console.warn(
    `[linux-deps] WARNING: no Cargo*.lock under ${root}; only direct declarations are visible, ` +
      'which is how a transitive crate like alsa-sys escapes this check.',
  );
  for (const crate of manifestCrates(root)) present.add(crate);
}

/** Crate names declared in every Cargo.toml under `dir`, as a flat set. */
function manifestCrates(dir) {
  const names = new Set();
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'target' || entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry === 'Cargo.toml') {
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          const key = /^\s*"?([A-Za-z0-9_-]+)"?\s*=/.exec(line)?.[1];
          if (key) names.add(key);
        }
      }
    }
  };
  walk(dir);
  return names;
}

const required = [];
for (const [crate, packages] of Object.entries(SYSTEM_DEPS)) {
  if (!present.has(crate)) continue;
  for (const dep of packages) required.push({ crate, ...dep });
}

/* What does the workflow install? --------------------------------------- */

const lines = readFileSync(workflow, 'utf8').replace(/\r\n/g, '\n').split('\n');
const install = lines.find((line) => LINUX_INSTALL.test(line));
if (!install) {
  console.error(
    `[linux-deps] FAILED: no Linux dependency step found in ${workflow}.\n` +
      '  Expected a `sudo apt-get install -y … pkg-config … libgtk-3-dev …` line.',
  );
  process.exit(1);
}

const installed = new Set(
  install
    .slice(install.indexOf('install -y') + 'install -y'.length)
    .replace(/\\\s*$/, '')
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-')),
);

/* Report ---------------------------------------------------------------- */

const relevant = Object.keys(SYSTEM_DEPS).filter((crate) => present.has(crate));
console.log(`[linux-deps] upstream checkout: ${root}`);
console.log(`[linux-deps] workflow:          ${workflow}`);
console.log(
  `[linux-deps] ${required.length} package(s) required by ${relevant.length} crate(s) known to need one`,
);

const missing = required.filter((dep) => !installed.has(dep.package));
if (missing.length) {
  console.error(
    `\n[linux-deps] FAILED: ${missing.length} package(s) the tree needs are not installed:\n` +
      missing.map((dep) => `  ${dep.package} — needed by ${dep.crate} (${dep.why})`).join('\n') +
      '\n  Add them to the "Install Linux build dependencies (Linux)" step of the workflow.\n' +
      '  Left alone, this fails 40 minutes into a build, in a leg unrelated to the change.',
  );
  process.exit(1);
}

for (const dep of required) console.log(`  ${dep.package.padEnd(16)} for ${dep.crate}`);
console.log('\n[linux-deps] every known build-time dependency is installed by the Linux step');
