#!/usr/bin/env node
/**
 * Points Cargo at the vendored `battery` crate, for the 32-bit Windows build
 * only.
 *
 * Why: `battery` 0.7.8 — the newest release, published in 2020 and abandoned
 * since — takes a reference to a field of a `#[repr(packed)]` struct in its
 * Windows FFI. That is `error[E0793]` with any modern rustc, and the lint became
 * a hard error, so no flag or `#[allow]` can get past it. readest pulls the
 * crate in transitively, so the fix has to live beside the build rather than in
 * the dependency.
 *
 * The vendored copy in `vendor/battery/` is the published crate with exactly two
 * lines changed: the two places that formed an unaligned reference now take a
 * raw pointer with `addr_of!` / `addr_of_mut!` instead. The access itself is
 * unchanged, and x86 tolerates the unaligned load.
 *
 * `[patch]` is only honoured in a workspace root manifest, which is why this
 * edits the repository's top-level Cargo.toml.
 *
 * Usage: node helpers/patch-battery-crate.mjs [--root <checkout>] [--recipe <name>]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '[readest-unlocked]';
const SECTION = '[patch.crates-io]';

function fail(message) {
  console.error(`\n[patch-battery] ERROR: ${message}\n`);
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const root = path.resolve(arg('root', process.env['READEST_ROOT'] ?? process.cwd()));
// Where the recipe repository is checked out inside the workspace.
const recipeDir = arg('recipe', '.recipe');

const manifest = path.join(root, 'Cargo.toml');
if (!existsSync(manifest)) {
  fail(`no workspace manifest at ${manifest}`);
}

const vendored = path.join(root, recipeDir, 'vendor', 'battery');
if (!existsSync(path.join(vendored, 'Cargo.toml'))) {
  fail(`the vendored crate is missing: ${vendored}`);
}

const entry = `battery = { path = "${recipeDir}/vendor/battery" }`;
const raw = readFileSync(manifest, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';

// Anchored at the start of a line, so a commented-out mention of the section
// further up the file cannot be mistaken for the real one.
const sectionRe = /^[ \t]*\[patch\.crates-io\][^\n]*\n/m;

if (raw.includes(entry)) {
  console.log('[patch-battery] the workspace manifest already points at the vendored crate');
  process.exit(0);
}

const patched = sectionRe.test(raw)
  ? raw.replace(sectionRe, (whole) => `${whole}${entry}${eol}`)
  : `${raw.replace(/\s*$/, '')}${eol}${eol}// ${MARKER} 32-bit Windows: see ${recipeDir}/vendor/battery/README.readest-unlocked.md${eol}${SECTION}${eol}${entry}${eol}`;
writeFileSync(manifest, patched, 'utf8');

// Read it back: the entry has to be inside the real section, not in a comment.
const check = readFileSync(manifest, 'utf8');
const header = check.match(sectionRe);
if (!header) {
  fail(`the patched manifest has no ${SECTION} section`);
}
const body = check.slice(header.index + header[0].length).split(/^[ \t]*\[/m)[0];
if (!body.includes(entry)) {
  fail(`the entry did not land in ${SECTION}; the manifest now reads:\n${check.slice(header.index, header.index + 300)}`);
}
console.log(
  sectionRe.test(raw)
    ? `[patch-battery] added battery to the existing ${SECTION} section`
    : `[patch-battery] appended a ${SECTION} section pointing at the vendored crate`,
);
