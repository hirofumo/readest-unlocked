#!/usr/bin/env node
/**
 * Asserts the one invariant that keeps a dry run dry: every command in the build
 * workflow that writes to a release is guarded by the `publish` output of
 * `detect`, which is `true` only on `main`.
 *
 * Why this exists: the guard is what makes pushing to `dev` safe, and it is
 * invisible when it is right. A platform added later, or a new upload step
 * copied from an old one, would happily publish from a development branch — and
 * nobody would notice until a release had assets from a branch nobody built for
 * users. This check runs in preflight every day, so the invariant fails loudly
 * instead.
 *
 * How it decides, and what it cannot see:
 *
 *   - The workflow is read as text, not parsed as YAML: the tools in this
 *     repository have no dependencies, and a YAML parser would be one.
 *   - Jobs are recognised by a two-space-indented `key:` line, steps by a
 *     six-space-indented `-` entry, and the `if:`/`run:` scalars that follow
 *     them are folded the way YAML folds them.
 *   - A write is guarded when the job's `if:` mentions `publish`, when the
 *     step's `if:` does, or when an enclosing shell `if` in the step's script
 *     (the write indented deeper than an `if ... publish` line) does. That
 *     covers both shapes the workflow uses: a step-level gate and the small
 *     `upload()` helper each leg defines.
 *   - It therefore cannot tell a *misplaced* guard from a correct one, only a
 *     missing one. That is the failure mode worth catching.
 *
 * Usage:
 *   node tools/check-workflow.mjs [--file <path>]
 *
 * Exits non-zero and prints every unguarded write when the invariant is broken.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PUBLISH = 'publish';
/** Line-level patterns for "this command writes to the release". */
const RELEASE_WRITES = [
  /\bgh\s+release\s+(create|upload|edit|delete|delete-asset)\b/,
  /\bgh\s+api\b.*\b(releases|git\/refs|git\/ref\/tags)\b/,
];

const parseFile = () => {
  const i = process.argv.indexOf('--file');
  if (i !== -1) {
    const value = process.argv[i + 1];
    if (!value) {
      console.error('[workflow] ERROR: --file requires a path');
      process.exit(1);
    }
    return path.resolve(value);
  }
  return path.resolve('.github', 'workflows', 'build-unlocked.yml');
};

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Read a YAML scalar that may span lines (`if: >-` / `run: |`). Returns the
 * text and the index of the last line it consumed.
 */
const readScalar = (lines, start) => {
  const header = lines[start];
  const rest = header.slice(header.indexOf(':') + 1).trim();
  const isBlock = /^[|>][-+]?[0-9]?$/.test(rest) || rest === '';
  if (!isBlock || rest === '') {
    // Either a plain scalar on the same line, or a nested mapping: an empty
    // value with nothing indented under it is nothing to read.
    return { text: rest, end: start };
  }
  const indent = indentOf(header);
  let end = start;
  let text = '';
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      text += '\n';
      continue;
    }
    if (indentOf(line) <= indent) break;
    text += `${line}\n`;
    end = i;
  }
  return { text, end };
};

/** `key: value` at exactly the given indentation, ignoring comments/blank lines. */
const isKeyAt = (line, indent, key) =>
  indentOf(line) === indent && new RegExp(`^\\s*${key}:`).test(line);

const file = parseFile();
if (!existsSync(file)) {
  console.error(`[workflow] ERROR: ${file} does not exist`);
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

/* The policy itself: only main publishes. ------------------------------- */

const policy = lines.find((line) => /^\s+publish:\s*\$\{\{/.test(line));
const policyText = policy?.slice(policy.indexOf(':') + 1).trim() ?? '';
const expected = `\${{ github.ref == 'refs/heads/main' }}`;
const failures = [];
if (policyText !== expected) {
  failures.push(
    `detect.outputs.publish is "${policyText}", expected "${expected}".\n` +
      '  Everything that writes to the release is gated on this value, so a change\n' +
      '  here decides which branches can publish. Update this assertion deliberately.',
  );
}

/* Walk the jobs, steps and every write in them. ------------------------- */

const guarded = [];
const unguarded = [];
let inJobs = false;
let job = '(workflow)';
let jobGuard = '';
let step = '(job-level)';
let stepGuard = '';
let stepBody = [];

const flushStep = () => {
  for (const entry of stepBody) {
    // Comments in a `run:` block talk about these commands; only real ones count.
    if (entry.text.trimStart().startsWith('#')) continue;
    if (!RELEASE_WRITES.some((pattern) => pattern.test(entry.text))) continue;
    // Only a guard that actually mentions `publish` counts: a job `if:` about
    // `build` says nothing about whether this write may run.
    const guardKind = jobGuard.includes(PUBLISH)
      ? `job if: ${jobGuard}`
      : stepGuard.includes(PUBLISH)
        ? `step if: ${stepGuard}`
        : stepBody
            .slice(0, entry.index)
            .filter(
              (line) =>
                /^\s*if\b/.test(line.text) &&
                line.text.includes(PUBLISH) &&
                indentOf(line.text) < entry.indent,
            )
            .map((line) => `shell if at line ${line.number}`)
            .pop();
    const record = { line: entry.number, job, step, text: entry.text.trim() };
    if (guardKind) guarded.push({ ...record, guard: guardKind });
    else unguarded.push(record);
  }
  stepBody = [];
};

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const body = line.trim();
  if (body === '' || body.startsWith('#')) {
    stepBody.push({ number: i + 1, text: line, index: stepBody.length, indent: indentOf(line) });
    continue;
  }

  if (indentOf(line) === 0 && /^jobs:/.test(body)) {
    inJobs = true;
    continue;
  }

  if (inJobs && isKeyAt(line, 2, '[A-Za-z0-9_-]+')) {
    flushStep();
    job = body.replace(/:.*$/, '');
    jobGuard = '';
    step = '(job-level)';
    stepGuard = '';
    continue;
  }

  if (indentOf(line) === 4 && /^if:/.test(body)) {
    const scalar = readScalar(lines, i);
    jobGuard = scalar.text.replace(/\s+/g, ' ').trim();
    i = scalar.end;
    continue;
  }

  if (/^\s{6}- /.test(line)) {
    flushStep();
    // The step's `name:` is the readable label; fall back to the raw entry.
    step = /^-\s*name:\s*(.+)$/.exec(body)?.[1] ?? body.replace(/^-\s*/, '');
    stepGuard = '';
    stepBody.push({ number: i + 1, text: line, index: 0, indent: indentOf(line) });
    continue;
  }

  if (stepBody.length && indentOf(line) === 8 && /^if:/.test(body)) {
    const scalar = readScalar(lines, i);
    stepGuard = scalar.text.replace(/\s+/g, ' ').trim();
    stepBody.push({ number: i + 1, text: line, index: stepBody.length, indent: indentOf(line) });
    i = scalar.end;
    continue;
  }

  if (stepBody.length && /^run:/.test(body)) {
    const scalar = readScalar(lines, i);
    scalar.text.split('\n').forEach((text, offset) => {
      stepBody.push({
        number: i + 2 + offset,
        text,
        index: stepBody.length,
        indent: indentOf(text),
      });
    });
    i = scalar.end;
    continue;
  }

  stepBody.push({ number: i + 1, text: line, index: stepBody.length, indent: indentOf(line) });
}
flushStep();

/* Report ---------------------------------------------------------------- */

console.log(`[workflow] checked ${file}`);
console.log(`[workflow] publishing is gated on: ${policyText}`);
console.log(`[workflow] ${guarded.length} release write(s) found, all guarded`);

if (process.argv.includes('--list')) {
  for (const entry of guarded) console.log(`  L${entry.line} ${entry.job}/${entry.step} -> ${entry.guard}`);
}

if (unguarded.length) {
  failures.push(
    `${unguarded.length} release write(s) are not guarded by \`${PUBLISH}\`:\n` +
      unguarded
        .map((entry) => `  L${entry.line} ${entry.job}/${entry.step}: ${entry.text}`)
        .join('\n') +
      '\n  Wrap each in the `upload()` helper the other legs use, or gate the step.',
  );
}

if (failures.length) {
  console.error(`\n[workflow] FAILED with ${failures.length} problem(s):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log('[workflow] every release write is guarded: a branch that is not main cannot publish');
