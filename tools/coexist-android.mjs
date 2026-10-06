#!/usr/bin/env node
/**
 * Rewrites the generated Android project to the coexisting family's package.
 *
 * Why this is needed at all: `identifier` in tauri.conf.json is not the only
 * thing that decides an Android application id. Upstream commits part of
 * src-tauri/gen/android (build.gradle.kts, AndroidManifest.xml, MainActivity.kt,
 * the launch resources), and the Android job follows `tauri android init` with
 * `git checkout .` to keep those committed files. That checkout puts the
 * original `com.bilingify.readest` project back, so a coexisting build has to
 * re-point it afterwards:
 *
 *   - build.gradle.kts  namespace = "com.bilingify.readest"  -> the new id
 *     (AGP takes applicationId from namespace when it is not set separately)
 *   - MainActivity.kt and the unit test carry `package com.bilingify.readest`
 *   - the Kotlin sources have to move to the matching directory, or the build
 *     ends up compiling two packages at once and fails with unresolved
 *     references to whichever one the generator wrote
 *
 * Tauri's own generated Kotlin (WryActivity, RustWebView, Logger, ...) is
 * written under the package taken from `identifier`, so after this rewrite both
 * halves agree.
 *
 * Run it AFTER `tauri android init` and after the `git checkout .` that follows
 * it, and before the build.
 *
 * Usage: node tools/coexist-android.mjs [--root <path>] [--from <id>] [--to <id>]
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Files worth rewriting; everything else under the project is binary. */
const TEXT_EXTENSIONS = new Set([
  '.kt',
  '.kts',
  '.java',
  '.xml',
  '.gradle',
  '.properties',
  '.pro',
  '.json',
  '.txt',
  '.md',
  '.toml',
  '.sh',
]);

function fail(message) {
  console.error(`\n[coexist-android] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[coexist-android] ${message}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const root = path.resolve(
  arg('root', process.env['READEST_ROOT'] ?? process.cwd()),
);
const from = arg('from', process.env['READEST_ANDROID_FROM'] ?? 'com.bilingify.readest');
const to = arg('to', process.env['READEST_COEXIST_IDENTIFIER'] ?? 'com.hirofumo.readest.unlocked');

const genDir = path.join(root, 'apps', 'readest-app', 'src-tauri', 'gen', 'android');
if (!existsSync(genDir)) {
  fail(`no generated Android project at ${genDir}; run 'tauri android init' first`);
}
if (from === to) fail(`--from and --to are both ${from}`);

const fromRel = from.split('.').join('/');
const toRel = to.split('.').join('/');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const isText = (file) =>
  TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) || path.basename(file) === 'gradlew';

/* 1. rewrite the package string, and move anything inside the old package ---- */

let rewritten = 0;
let moved = 0;

for (const file of walk(genDir)) {
  const rel = path.relative(genDir, file).split(path.sep).join('/');

  if (isText(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(from)) {
      writeFileSync(file, text.split(from).join(to), 'utf8');
      rewritten += 1;
    }
  }

  if (rel.includes(`${fromRel}/`)) {
    const destination = path.join(genDir, rel.split(`${fromRel}/`).join(`${toRel}/`));
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(file, destination);
    moved += 1;
  }
}

log(`rewrote ${rewritten} file(s), moved ${moved} source file(s) under ${toRel}/`);

/* 2. drop the directories the move emptied ---------------------------------- */

const pruneEmpty = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    pruneEmpty(full);
    if (readdirSync(full).length === 0) rmdirSync(full);
  }
};
pruneEmpty(genDir);

/* 3. assert the project really is the other family's now -------------------- */

const leftovers = walk(genDir).filter((file) => isText(file) && readFileSync(file, 'utf8').includes(from));
if (leftovers.length) {
  fail(
    `these files still reference ${from}:\n  ` +
      leftovers.map((file) => path.relative(genDir, file)).join('\n  '),
  );
}

const gradle = path.join(genDir, 'app', 'build.gradle.kts');
if (!existsSync(gradle)) fail(`missing ${gradle}`);
const gradleText = readFileSync(gradle, 'utf8');
if (!gradleText.includes(`namespace = "${to}"`)) {
  fail(`app/build.gradle.kts does not declare namespace = "${to}"`);
}

const mainActivity = path.join(genDir, 'app', 'src', 'main', 'java', toRel, 'MainActivity.kt');
if (!existsSync(mainActivity)) {
  fail(`MainActivity.kt is not at app/src/main/java/${toRel}/`);
}
if (!readFileSync(mainActivity, 'utf8').includes(`package ${to}`)) {
  fail(`MainActivity.kt does not declare package ${to}`);
}

log(`project identity is now ${to} (namespace, MainActivity and test sources)`);
