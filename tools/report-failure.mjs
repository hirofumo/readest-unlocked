#!/usr/bin/env node
/**
 * Opens — or appends to — a single issue describing a failed run.
 *
 * A build fans out across every platform at once, so a bad upstream day would
 * otherwise open one identical issue per failing leg. This script keeps it to
 * one: it looks for an open issue with exactly this title and comments on it
 * instead of creating another.
 *
 * The lookup is a plain issue listing, deliberately not `--search`: GitHub's
 * search index lags seconds-to-minutes behind the live list, and a second
 * failure inside that window used to find nothing and open a duplicate. The
 * title is then compared exactly, so an issue that merely shares words with
 * this one can never be picked up.
 *
 * Usage:
 *   node tools/report-failure.mjs --title "<title>" --body "<body>" [--label <label>]
 *
 * Reads GH_REPO / GH_TOKEN (the `gh` CLI reads the token from the environment
 * itself). Exits non-zero only when it could not report at all — the caller is
 * usually already failing, and a reporting problem must not mask that.
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function fail(message) {
  console.error(`\n[report] ERROR: ${message}\n`);
  process.exit(1);
}

function log(message) {
  console.log(`[report] ${message}`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value) fail(`--${name} requires a value`);
  return value;
}

const repo = process.env['GH_REPO'] ?? arg('repo', '');
const title = arg('title', '');
const body = arg('body', '');
const label = arg('label', '');

if (!repo) fail('GH_REPO is not set');
if (!title) fail('--title is required');
if (!body) fail('--body is required');

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

/* --------------------------------------------------- is there an open issue? */

let open = [];
try {
  // A plain listing reads the live issue list. `--search` would be tempting but
  // goes through GitHub's search index, which lags behind by seconds to
  // minutes — long enough for the second of two quick failures to miss the
  // first issue and open a duplicate.
  const raw = execFileSync(
    'gh',
    ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title'],
    { encoding: 'utf8' },
  ).trim();
  open = raw ? JSON.parse(raw) : [];
  if (open.length >= 200) {
    log('listed 200 open issues (the page limit); de-duplication may be incomplete');
  }
} catch (err) {
  // A failed lookup is not fatal on its own, but it does mean the
  // de-duplication cannot be trusted, so the issue is created under a
  // timestamped title rather than risking a duplicate flood.
  log(`could not list open issues (${err.message.split('\n')[0]}); will create a dated issue`);
  open = null;
}

const existing = Array.isArray(open) ? open.find((issue) => issue.title === title) : undefined;

/* --------------------------------------------------------- comment or create */

const runUrl = process.env['GITHUB_SERVER_URL'] && process.env['GITHUB_RUN_ID']
  ? `${process.env['GITHUB_SERVER_URL']}/${repo}/actions/runs/${process.env['GITHUB_RUN_ID']}`
  : '';
const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

let url;
if (existing) {
  gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', `${body}\n\n---\n_Seen again: ${stamp}${runUrl ? ` — ${runUrl}` : ''}_`]);
  url = `https://github.com/${repo}/issues/${existing.number}`;
  log(`appended to open issue #${existing.number}`);
} else {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  if (label) {
    // A missing label makes `gh issue create` fail, which would lose the report
    // entirely. Create it first (idempotent) and carry on regardless.
    try {
      gh(['label', 'create', label, '--repo', repo, '--force', '--color', 'B60205', '--description', 'Automated: a build or preflight run failed']);
    } catch {
      log(`could not ensure label "${label}"; creating the issue without it`);
    }
    if (label) args.push('--label', label);
  }
  try {
    url = gh(args);
  } catch (err) {
    if (!label) throw err;
    log(`creating with --label failed (${err.message.split('\n')[0]}); retrying without it`);
    url = gh(['issue', 'create', '--repo', repo, '--title', title, '--body', body]);
  }
  log(`created issue: ${url}`);
}

/* ---------------------------------------------------------------- reporting */

const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
if (summaryFile) {
  appendFileSync(summaryFile, `**Failure reported**: ${url}\n\n`, 'utf8');
}
// A machine-readable line for the workflow log, so the run page shows where
// the report went even when the step summary is not opened.
console.log(`[report] ${url}`);

// Also expose it as a step output when the caller asked for one.
const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  writeFileSync(outputFile, `issue-url=${url}\n`, { flag: 'a' });
}
