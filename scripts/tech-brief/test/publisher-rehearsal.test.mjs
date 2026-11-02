// TEMPORARY (Security Work Package 2): static checks of the one-off publisher
// App rehearsal workflow. Remove together with
// .github/workflows/tech-brief-publisher-rehearsal.yml after the rehearsal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) =>
  readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
const TEXT = read(".github/workflows/tech-brief-publisher-rehearsal.yml");
const PUBLISH = read(".github/workflows/tech-brief-publish.yml");
const BRANCH = "rehearsal/publisher-app";
const PUSH = 'git push origin "HEAD:refs/heads/$REHEARSAL_BRANCH"';

/** { jobName: text } for the jobs: section. */
function jobs(text) {
  const lines = text.split("\n");
  const result = {};
  let name = null;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const header = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (header) result[(name = header[1])] = "";
    else if (name) result[name] += `${line}\n`;
  }
  return result;
}
/** Text of every step run: script (single line or block). */
function runScripts(text) {
  const scripts = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(- )?run:\s*(.*)$/);
    if (!m || (!m[2] && m[1].length < 8)) continue;
    const column = m[1].length + (m[2] ? 2 : 0);
    let body = m[3] === "|" ? "" : m[3];
    if (m[3] === "|")
      while (
        i + 1 < lines.length &&
        (lines[i + 1].trim() === "" || lines[i + 1].search(/\S/) > column)
      )
        body += `${lines[++i]}\n`;
    scripts.push(body);
  }
  return scripts;
}
const steps = (job) =>
  job
    .split(/\n {6}- /)
    .slice(1)
    .map((step) => `${step.trimEnd()}\n`);
/** A step's `with:` or `env:` block, verbatim. */
const block = (step, section) =>
  step.match(new RegExp(`\\n {8}${section}:\\n((?: {10}[^\\n]*\\n)+)`))?.[1];
const top = TEXT.slice(0, TEXT.indexOf("\njobs:"));
const JOBS = jobs(TEXT);
const SCRIPTS = runScripts(TEXT);
const count = (re, text = TEXT) => (text.match(re) ?? []).length;

test("rehearsal: temporary, manual only, from main, isolated branch and concurrency group", () => {
  assert.match(TEXT, /^# TEMPORARY \(Security Work Package 2\)/);
  assert.match(top, /\non:\n {2}workflow_dispatch:\n\npermissions: \{\}\n/);
  assert.ok(!/inputs:|schedule:|push:|pull_request|workflow_run/.test(top));
  assert.match(
    top,
    /\nconcurrency:\n {2}group: tech-brief-publisher-rehearsal\n {2}cancel-in-progress: false\n/,
  );
  assert.match(top, new RegExp(`\\n {2}REHEARSAL_BRANCH: ${BRANCH}\\n`));
  assert.deepEqual(Object.keys(JOBS), [
    "unauthorized",
    "publisher",
    "untouched",
  ]);
  for (const [name, job] of Object.entries(JOBS))
    assert.match(job, /^ {4}if: .*github\.ref == 'refs\/heads\/main'$/m, name);
  assert.match(JOBS.publisher, /^ {4}needs: unauthorized$/m);
  assert.match(JOBS.untouched, /^ {4}needs: \[unauthorized, publisher\]$/m);
  assert.match(JOBS.untouched, /^ {4}if: always\(\) && /m);
});

test("rehearsal: least privilege; only the publisher job holds the App key", () => {
  const permissions = (job) =>
    job.match(/\n {4}permissions:\n((?: {6}[^\n]*\n)+)/)[1].trim();
  assert.equal(permissions(JOBS.unauthorized), "contents: write");
  assert.equal(permissions(JOBS.publisher), "contents: read");
  assert.equal(permissions(JOBS.untouched), "contents: read");
  assert.deepEqual(
    [...TEXT.matchAll(/environment: ([a-z-]+)/g)].map((m) => m[1]),
    ["tech-brief-publish"],
  );
  assert.match(JOBS.publisher, /\n {4}environment: tech-brief-publish\n/);
  assert.deepEqual(
    [...TEXT.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ["TECH_BRIEF_PUBLISHER_APP_KEY"],
  );
  assert.ok(JOBS.publisher.includes("secrets.TECH_BRIEF_PUBLISHER_APP_KEY"));
  for (const forbidden of ["OPENAI", "ARTIFACT_KEY", "CORRECTIONS", "gh issue"])
    assert.ok(!TEXT.includes(forbidden), forbidden);
  // The workflow token only in the unauthorized push; the App token only in the publisher push.
  assert.equal(count(/github\.token/g), 1);
  assert.match(JOBS.unauthorized, /PUSH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.equal(count(/steps\.publisher-token\.outputs\.token/g), 1);
});

test("rehearsal: the App token is created exactly as in publication, with the same pinned actions", () => {
  const mint = (text) =>
    steps(text).find((s) =>
      s.includes("uses: actions/create-github-app-token@"),
    );
  const rehearsal = mint(JOBS.publisher);
  const publication = mint(jobs(PUBLISH).publish);
  assert.equal(
    rehearsal.match(/uses: (\S+)/)[1],
    publication.match(/uses: (\S+)/)[1],
  );
  assert.equal(block(rehearsal, "with"), block(publication, "with"));
  assert.match(rehearsal, /^id: publisher-token\n/);
  // Every action is pinned to a SHA that publication already uses.
  const pinned = new Set(
    [...PUBLISH.matchAll(/uses: (\S+@[0-9a-f]{40})/g)].map((m) => m[1]),
  );
  for (const m of TEXT.matchAll(/uses: (\S+)/g))
    assert.ok(pinned.has(m[1]), m[1]);
  // Checkouts keep no credentials and use the exact dispatched commit.
  assert.equal(count(/uses: actions\/checkout@/g), 2);
  assert.equal(count(/persist-credentials: false/g), 2);
  assert.equal(count(/ref: \$\{\{ github\.sha \}\}/g), 2);
});

test("rehearsal: credentials reach Git only through the publication's step-scoped helper", () => {
  const helper = (step) => block(step, "env").split("\n").slice(1).join("\n");
  const publication = steps(jobs(PUBLISH).publish).find((s) =>
    s.includes("run: git push origin HEAD:main"),
  );
  const expected = helper(publication).replaceAll("PUBLISHER_TOKEN", "TOKEN");
  const holders = Object.values(JOBS)
    .flatMap(steps)
    .filter((s) => /git push/.test(s));
  assert.equal(holders.length, 2);
  for (const step of holders) {
    assert.match(
      step,
      /\n {8}env:\n {10}(PUSH_TOKEN|PUBLISHER_TOKEN): \$\{\{ [^}]+ \}\}\n/,
    );
    assert.equal(
      helper(step).replace(/PUSH_TOKEN|PUBLISHER_TOKEN/g, "TOKEN"),
      expected,
    );
  }
  for (const s of SCRIPTS)
    for (const leak of [
      /set -x/,
      /GIT_TRACE|GIT_CURL_VERBOSE/,
      /extraheader/,
      /echo[^\n]*(PUSH_TOKEN|PUBLISHER_TOKEN)/,
      /https:\/\/[^\s]*@/,
      /GITHUB_ENV/,
      /x-access-token/,
    ])
      assert.ok(!leak.test(s), `${leak}`);
  assert.ok(!/upload-artifact|actions\/cache|GIT_TRACE/.test(TEXT));
  for (const s of SCRIPTS) assert.ok(!s.includes("${{"), s.slice(0, 60));
});

test("rehearsal: pushes go only to the rehearsal branch, without force, and only empty commits are meant to land", () => {
  assert.ok(!["main", "tech-brief-ledger"].includes(BRANCH));
  const pushes = SCRIPTS.join("\n").match(/git push[^\n;]*/g);
  assert.deepEqual(pushes, [
    `${PUSH} 2> "$RUNNER_TEMP/unauthorized.err"`,
    `${PUSH} 2> "$RUNNER_TEMP/probe.err"`,
    PUSH,
  ]);
  for (const forbidden of ["--force", "push -f", "--delete", " +HEAD", ":main"])
    assert.ok(!TEXT.includes(forbidden), forbidden);
  const all = SCRIPTS.join("\n");
  // Both pushes meant for the branch are empty commits.
  assert.equal(count(/commit --allow-empty -q -m/g, all), 2);
  // The only file ever added is the inert workflow probe, which must be refused.
  assert.deepEqual(all.match(/git add [^\n]*/g), [
    "git add .github/workflows/publisher-rehearsal-probe.yml",
  ]);
  assert.match(
    all,
    /"on: workflow_dispatch" "jobs:" "  probe:" "    if: false"/,
  );
  assert.match(all, /git reset -q --hard "\$authorized"\n\s+git push/);
});

test("rehearsal: each expected refusal is asserted, and the accepted push is confirmed", () => {
  const [unauthorized] = runScripts(
    steps(JOBS.unauthorized).find((s) => s.includes("git push")),
  );
  assert.match(
    unauthorized,
    /if git push [^\n]*; then\n\s+echo "::error::[^\n]*"\n\s+exit 1\n\s+fi\n/,
  );
  assert.match(unauthorized, /grep -qiE "GH013\|rule violation"/);
  const [publisher] = runScripts(
    steps(JOBS.publisher).find((s) => s.includes("git push")),
  );
  assert.match(
    publisher,
    /test "\$repos" = "\$GITHUB_REPOSITORY"\n/,
    "token limited to this repository",
  );
  assert.match(
    publisher,
    /if git push [^\n]*probe\.err"; then\n\s+echo "::error::[^\n]*"\n\s+exit 1\n\s+fi\n/,
  );
  assert.match(publisher, /grep -qiE "without \.\?workflows\.\? permission"/);
  assert.match(
    publisher,
    /test "\$\(git ls-remote origin "refs\/heads\/\$REHEARSAL_BRANCH" \| cut -f1\)" = "\$authorized"/,
  );
  // The final job fails unless main and the ledger stayed put and the App commit landed.
  const [untouched] = runScripts(JOBS.untouched);
  for (const check of [
    'test "$main" = "$GITHUB_SHA"',
    'test -n "$LEDGER_BEFORE" && test "$ledger" = "$LEDGER_BEFORE"',
    'test "$UNAUTHORIZED" = success && test "$PUBLISHER" = success',
    'test "$branch" = "$APP_COMMIT"',
  ])
    assert.ok(untouched.includes(check), check);
  // The branch must start at the dispatched main commit.
  assert.match(
    JOBS.unauthorized,
    /if \[ "\$branch" != "\$GITHUB_SHA" \]; then/,
  );
});
