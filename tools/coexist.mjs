#!/usr/bin/env node
/**
 * Turns a patched Readest checkout into the *coexisting* Android variant.
 *
 * Android takes the application id from tauri.conf.json's `identifier`, and
 * `tauri android init` bakes it into the generated Gradle project. Giving the
 * variant its own id and label lets it install next to the official app instead
 * of replacing it, and its own updater manifest keeps it from ever being offered
 * the replacing variant's APK (two different application ids cannot update each
 * other).
 *
 * Run this after tools/unlock.mjs, then commit: the Android job follows it with
 * `tauri android init` and a `git checkout .`, which restores the committed
 * state — so the coexist identity has to be committed first or that checkout
 * would silently revert it.
 *
 * Usage: node tools/coexist.mjs [--root <path-to-readest-checkout>]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = '[readest-unlocked]';
const IDENTIFIER = process.env['READEST_COEXIST_IDENTIFIER'] ?? 'com.hirofumo.readest.unlocked';
const MANIFEST_FILE = 'latest-coexist.json';

const failures = [];

function fail(message) {
  console.error(`\n[coexist] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[coexist] ${message}`);
}

function parseRoot() {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const value = process.argv[i + 1];
    if (!value) fail('--root requires a path');
    return path.resolve(value);
  }
  return path.resolve(process.env['READEST_ROOT'] ?? process.cwd());
}

function readText(file) {
  if (!existsSync(file)) fail(`expected file is missing: ${file}`);
  const raw = readFileSync(file, 'utf8');
  return { text: raw.replace(/\r\n/g, '\n'), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

function writeText(file, text, eol) {
  writeFileSync(file, eol === '\n' ? text : text.replace(/\n/g, eol), 'utf8');
}

const root = parseRoot();
if (!existsSync(path.join(root, 'apps', 'readest-app'))) {
  fail(`not a Readest checkout (apps/readest-app not found): ${root}`);
}

log(`building the coexisting variant at ${root}`);

/* 1. identity ------------------------------------------------------------- */

const confFile = path.join(root, 'apps', 'readest-app', 'src-tauri', 'tauri.conf.json');
{
  const { text: original, eol } = readText(confFile);
  let text = original;

  if (!/"identifier"\s*:\s*"[^"]*"/.test(text)) fail('tauri.conf.json has no identifier');
  text = text.replace(/"identifier"\s*:\s*"[^"]*"/, `"identifier": "${IDENTIFIER}"`);

  // productName is deliberately left alone: both families are labelled "Readest"
  // and only the About dialog explains which one is installed.
  if (text !== original) writeText(confFile, text, eol);

  let conf;
  try {
    conf = JSON.parse(readFileSync(confFile, 'utf8'));
  } catch (err) {
    fail(`tauri.conf.json is not valid JSON after patching: ${err.message}`);
  }
  if (conf.identifier !== IDENTIFIER) fail(`identifier is ${conf.identifier}, expected ${IDENTIFIER}`);
  if (conf.productName !== 'Readest') {
    fail(`productName is ${conf.productName}, expected it to stay "Readest"`);
  }
  log(`identity: ${IDENTIFIER} (label stays "Readest")`);
}

/* 2. its own updater manifest --------------------------------------------- */

const constantsFile = path.join(root, 'apps', 'readest-app', 'src', 'services', 'constants.ts');
{
  const { text: original, eol } = readText(constantsFile);
  let text = original;

  const patterns = [
    {
      label: 'READEST_UPDATER_FILE',
      pattern: /export const READEST_UPDATER_FILE = `\$\{LATEST_DOWNLOAD_BASE_URL\}\/[^`]*`;/,
    },
    {
      label: 'READEST_NIGHTLY_UPDATER_FILE',
      pattern: /export const READEST_NIGHTLY_UPDATER_FILE = `\$\{LATEST_DOWNLOAD_BASE_URL\}\/[^`]*`;/,
    },
  ];

  for (const { label, pattern } of patterns) {
    if (!pattern.test(text)) {
      // unlock.mjs owns these lines; reaching here means it changed shape.
      failures.push(label);
      continue;
    }
    text = text.replace(
      pattern,
      () => `export const ${label} = \`\${LATEST_DOWNLOAD_BASE_URL}/${MANIFEST_FILE}\`;`,
    );
  }

  if (!failures.length && text !== original) writeText(constantsFile, text, eol);

  if (failures.length) {
    fail(
      `could not point these constants at ${MANIFEST_FILE}: ${failures.join(', ')}. ` +
        'unlock.mjs and coexist.mjs disagree about constants.ts; update both.',
    );
  }
  log(`updater manifest: ${MANIFEST_FILE}`);
}

/* 3. tell the two families apart where it matters --------------------------- */

/**
 * Both families ship as "Readest", so the About dialog is the only place a user
 * can tell which one is installed. unlock.mjs has already written the generic
 * modification notice; this adds the sentence that names the difference.
 */
const COEXIST_SENTINEL = `{/* ${MARKER} coexisting build notice */}`;

const aboutFile = path.join(root, 'apps', 'readest-app', 'src', 'components', 'AboutWindow.tsx');
{
  const { text: original, eol } = readText(aboutFile);
  if (original.includes(COEXIST_SENTINEL)) {
    log('AboutWindow.tsx: coexisting notice already present');
  } else {
    const anchor = `            {/* ${MARKER} modification notice (AGPL section 5) */}`;
    if (!original.includes(anchor)) {
      fail(
        'AboutWindow.tsx: the modification notice is missing, so unlock.mjs did not run first. ' +
          'Run tools/unlock.mjs before tools/coexist.mjs.',
      );
    }
    const notice = `            ${COEXIST_SENTINEL}
            <p className='text-neutral-content text-xs'>
              This is the coexisting build: it installs alongside the official Readest app under
              its own application id (${IDENTIFIER}) and keeps its own library.
            </p>
${anchor}`;
    writeText(aboutFile, original.replace(anchor, () => notice), eol);
    log(`AboutWindow.tsx: added the coexisting build notice (${IDENTIFIER})`);
  }
}

log(`done: this checkout builds the coexisting variant (${MARKER})`);
