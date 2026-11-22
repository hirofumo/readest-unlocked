#!/usr/bin/env node
/**
 * Proves an Android build exports the JNI entry points its Kotlin side calls.
 *
 * A native method is resolved by symbol name, and that name carries the
 * package: `Java_<package, dots as underscores>_<Class>_<method>`. When a build
 * renames its application id — this project's coexisting packages do — the
 * Kotlin half moves to the new package and starts asking for the new symbol,
 * while a Rust export that was not renamed keeps answering to the old one. The
 * call then dies with `UnsatisfiedLinkError`, at a moment the code chose:
 * upstream's `MainActivity.onCreate` asks `isEinkDevice()` before the window
 * exists, so every device crashed while the build reported success (#14).
 *
 * The expectation is therefore read from the Kotlin sources, not the Rust ones:
 * the caller decides which symbol has to exist. A prefix check would not have
 * caught #14 either, because Tauri's generated `Rust_*` symbols already carry
 * the new package — so each declaration is compared on its own.
 *
 * Usage:
 *   node tools/check-android-jni.mjs --apk <path> [--root <readest checkout>] [--package <id>]
 *
 * Exits non-zero when a declared entry point is missing from the APK's
 * libraries. When the Kotlin sources declare none there is nothing to check,
 * and it says so rather than passing silently.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const log = (message) => console.log(`[android-jni] ${message}`);

function fail(message) {
  console.error(`\n[android-jni] ERROR: ${message}\n`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === undefined) fail(`--${name} is required`);
    return fallback;
  }
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const apk = arg('apk');
const root = path.resolve(arg('root', process.env['READEST_ROOT'] ?? process.cwd()));
const applicationId = arg('package');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/** Quote a value for the one shell this script drives. */
const quote = (value) => `'${value.split("'").join(`'\\''`)}'`;

/**
 * Runs a pipeline through bash and answers "did it match". grep's status is the
 * pipeline's, so a match ends it early and unzip's SIGPIPE stays out of the
 * answer; `-a` keeps grep from treating the library as binary and giving up.
 */
const memberMatches = (member, needle) => {
  const command = `unzip -p ${quote(apk)} ${quote(member)} | grep -aqF ${quote(needle)}`;
  return spawnSync('bash', ['-c', command], { stdio: 'ignore' }).status === 0;
};

const listMembers = (pattern) => {
  const result = spawnSync('unzip', ['-Z1', apk], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`cannot read ${apk}: ${(result.stderr ?? '').trim() || 'unzip failed'}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => pattern.test(line));
};

/* 1. what the Kotlin side asks the library for ------------------------------ */

const genDir = path.join(root, 'apps', 'readest-app', 'src-tauri', 'gen', 'android');
if (!existsSync(genDir)) {
  fail(`missing ${genDir}; run 'tauri android init' before checking the APK`);
}

/**
 * `external fun isEinkDevice()` and `native boolean isEinkDevice()` both resolve
 * against the enclosing class, so each declaration is attributed to the last
 * `class` seen above it in the file. Tauri's generated sources follow the same
 * rule, which is why the result covers everything the build could call.
 *
 * The symbol is built from the package the APK is supposed to declare, not from
 * the file's `package` line: at run time the JVM uses the installed package, so
 * a project whose Kotlin still says the old one is a defect of its own and is
 * reported as such.
 */
const declarationsIn = (text) => {
  const pkg = text.match(/^package\s+([\w.]+)/m)?.[1];
  if (!pkg) return [];

  const found = [];
  let className = null;
  for (const line of text.split('\n')) {
    className = line.match(/\bclass\s+(\w+)/)?.[1] ?? className;
    const method = line.match(/\bexternal\s+fun\s+(\w+)\s*\(/)?.[1]
      ?? line.match(/\bnative\s+[\w.<>[\]]+\s+(\w+)\s*\(/)?.[1];
    if (method && className) {
      found.push({
        symbol: `Java_${applicationId.split('.').join('_')}_${className}_${method}`,
        declaredIn: pkg,
        source: `${pkg}.${className}.${method}`,
      });
    }
  }
  return found;
};

const declared = [];
for (const file of walk(genDir)) {
  if (!/\.(kt|java)$/.test(file)) continue;
  declared.push(...declarationsIn(readFileSync(file, 'utf8')));
}

/** A source tree still sitting on another package cannot answer the APK. */
const foreign = declared.filter((entry) => entry.declaredIn !== applicationId);
if (foreign.length) {
  fail(
    `these native declarations are not in ${applicationId}, the package the APK must declare:\n  ` +
      foreign.map((entry) => entry.source).join('\n  ') +
      '\nThe Kotlin half did not follow the package rename.',
  );
}

const bySymbol = new Map(declared.map((entry) => [entry.symbol, entry]));
const expected = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

if (expected.length === 0) {
  log('the Android sources declare no native method; nothing to check');
  process.exit(0);
}

/* 2. what the libraries actually export ------------------------------------- */

const libraries = listMembers(/^lib\/[^/]+\/.*\.so$/);
if (libraries.length === 0) fail(`${apk} carries no native library under lib/*/`);

const missing = expected.filter(
  (entry) => !libraries.some((member) => memberMatches(member, entry.symbol)),
);

if (missing.length) {
  fail(
    `${apk} does not export ${missing.length} of the ${expected.length} native method(s) ` +
      `its sources declare under ${applicationId}:\n  ` +
      missing.map((entry) => `${entry.symbol}  (${entry.source})`).join('\n  ') +
      `\n  searched: ${libraries.join(', ')}\n` +
      'A package rename has to move the Rust JNI symbols too (tools/coexist-android.mjs).',
  );
}

log(`${apk} answers all ${expected.length} declared native method(s) under ${applicationId}:`);
for (const entry of expected) log(`  ${entry.symbol}  (${entry.source})`);