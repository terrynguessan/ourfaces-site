// Static checks of the Tech Brief GitHub Actions workflows: activation gate,
// permissions, secret scoping, pinned actions, schedules and script hygiene.
// The files are read as text; jobs are split by their two-space indentation.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { RESEARCH_WORKFLOW_PATH, gate } from "../automation.mjs";
import { REHEARSAL_WORKFLOW_PATH } from "../rehearsal.mjs";
import { RECOMMENDED_TRIGGERS } from "../schedule.mjs";

const ROOT = new URL("../../../", import.meta.url);
const read = (path) =>
  readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
const WORKFLOWS = {
  research: read(RESEARCH_WORKFLOW_PATH),
  publish: read(".github/workflows/tech-brief-publish.yml"),
  preview: read(".github/workflows/tech-brief-preview.yml"),
  rehearsal: read(REHEARSAL_WORKFLOW_PATH),
  ci: read(".github/workflows/tech-brief-ci.yml"),
};
const PINNED = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
  "actions/download-artifact": "9000827ccba6bdab643e8b6fd33ac0654aef8333",
};

/** { jobName: text } for the jobs: section. */
function jobs(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  const result = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      name = header[1];
      result[name] = "";
    } else if (name) result[name] += `${line}\n`;
  }
  return result;
}
/** Text of every run: script (single line or block). */
function runScripts(text) {
  const scripts = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Step scripts: "- run:" or "run:" inside a step (deeper than a job's outputs).
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
const top = (text) => text.slice(0, text.indexOf("\njobs:"));

test("the text helpers find step scripts and jobs, and ignore job outputs", () => {
  const sample = [
    "jobs:",
    "  one:",
    "    outputs:",
    "      run: ${{ steps.x.outputs.run }}",
    "    steps:",
    "      - run: echo a",
    "      - id: b",
    "        run: |",
    "          echo ${{ inputs.bad }}",
    "",
    "          echo c",
    "      - run: |",
    "          echo d",
    "  two:",
    "    steps:",
    "      - run: echo e",
    "",
  ].join("\n");
  assert.deepEqual(Object.keys(jobs(sample)), ["one", "two"]);
  assert.deepEqual(runScripts(sample), [
    "echo a",
    "          echo ${{ inputs.bad }}\n\n          echo c\n",
    "          echo d\n",
    "echo e",
  ]);
});

test("the workflow files exist where the code expects them", () => {
  for (const path of [
    RESEARCH_WORKFLOW_PATH,
    REHEARSAL_WORKFLOW_PATH,
    ".github/workflows/tech-brief-publish.yml",
    ".github/workflows/tech-brief-preview.yml",
    ".github/workflows/tech-brief-ci.yml",
  ])
    assert.ok(existsSync(new URL(path, ROOT)), path);
});

/** The job's `if:` condition. */
const condition = (job) => job.match(/^ {4}if: (.*)$/m)?.[1];
/**
 * Evaluates an activation condition the way GitHub does for these operands:
 * `==` compares strings case-insensitively; an unset variable is ''. Only
 * the two contexts below, string literals, &&, || and parentheses are allowed.
 */
function evaluate(expression, { automation, event }) {
  const operand = (token) => {
    if (token === "vars.TECH_BRIEF_AUTOMATION") return automation ?? "";
    if (token === "github.event_name") return event;
    const literal = token.match(/^'([^']*)'$/);
    if (!literal) throw new Error(`Unexpected operand ${token}`);
    return literal[1];
  };
  const js = expression.replace(
    /([\w.]+|'[^']*') == ([\w.]+|'[^']*')/g,
    (_, a, b) => String(operand(a).toLowerCase() === operand(b).toLowerCase()),
  );
  assert.match(js, /^(true|false|&&|\|\||[() ])+$/, expression);
  return Function(`return ${js}`)();
}
const STATES = [undefined, "", "off", "manual", "enabled"];
// Unknown, misspelt or differently cased values: GitHub may start the job
// (its == ignores case) but gate() must refuse them.
const UNKNOWN = ["Enabled", "MANUAL", "true", "on", "disabled", " enabled"];
const TRIGGERS = ["schedule", "workflow_dispatch"];
const EVENTS = ["schedule", "workflow_dispatch", "push", "pull_request"];
const allowed = (automation, event) =>
  (automation === "enabled" &&
    ["schedule", "workflow_dispatch"].includes(event)) ||
  (automation === "manual" && event === "workflow_dispatch");

test("activation states: off, manual (dispatch only) and enabled, in both production workflows and in gate()", () => {
  const conditions = {
    research: condition(jobs(WORKFLOWS.research).plan),
    publish: condition(jobs(WORKFLOWS.publish).publish),
    preview: condition(jobs(WORKFLOWS.preview).preview),
  };
  assert.equal(conditions.research, conditions.publish);
  assert.equal(conditions.preview, conditions.publish);
  // Production workflows receive exactly these events.
  for (const name of ["research", "publish"]) {
    const on = top(WORKFLOWS[name]).match(/^on:$([\s\S]*?)^\S/m)[1];
    assert.deepEqual(
      [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]),
      TRIGGERS,
      name,
    );
  }
  const ok = { ref: "refs/heads/main", policy: { status: "approved" } };
  for (const [workflow, expression] of Object.entries(conditions))
    for (const automation of [...STATES, ...UNKNOWN])
      for (const event of EVENTS) {
        const starts = evaluate(expression, { automation, event });
        const production =
          gate({ ...ok, event, automation }).run === "production";
        const label = `${workflow} ${JSON.stringify(automation)} ${event}`;
        // For the events these workflows receive, a known state starts the job
        // exactly when it may do production work.
        if (!UNKNOWN.includes(automation) && TRIGGERS.includes(event))
          assert.equal(starts, allowed(automation, event), label);
        // Production work needs both layers; together they allow exactly the intended cases.
        assert.equal(starts && production, allowed(automation, event), label);
        assert.equal(
          production,
          allowed(automation, event),
          `gate(): ${label}`,
        );
      }
  // Manual mode: schedules never start a job, so nothing is published automatically.
  for (const expression of Object.values(conditions))
    assert.equal(
      evaluate(expression, { automation: "manual", event: "schedule" }),
      false,
    );
  // The rehearsal ignores the activation variable entirely.
  assert.ok(!WORKFLOWS.rehearsal.includes("TECH_BRIEF_AUTOMATION"));
});

test("activation gate: every production job depends on the gated first job", () => {
  const research = jobs(WORKFLOWS.research);
  // Every other job depends on plan (directly or through reserve).
  assert.match(research.reserve, /needs: plan\n/);
  assert.match(research.reserve, /if: needs.plan.outputs.run == 'production'/);
  assert.match(research.research, /needs: \[plan, reserve\]/);
  assert.match(research.settle, /needs: \[plan, reserve, research\]/);
  assert.match(research.settle, /needs.reserve.result == 'success'/);
  const publish = jobs(WORKFLOWS.publish);
  for (const job of [research.plan, publish.publish])
    assert.match(condition(job), /vars\.TECH_BRIEF_AUTOMATION/);
  assert.match(publish["verify-live"], /needs: publish\n/);
  assert.match(
    publish["verify-live"],
    /needs.publish.outputs.status == 'prepared'/,
  );
  // The paid and publishing steps also need the planner's "production" decision.
  assert.match(publish.publish, /steps.plan.outputs.run == 'production'/);
  for (const job of [research.alert, publish.alert])
    assert.match(job, /if: failure\(\)/);
  // Alerts only follow a failure of a gated job; the planner passes the variable on.
  for (const text of [WORKFLOWS.research, WORKFLOWS.publish])
    assert.match(
      text,
      /TECH_BRIEF_AUTOMATION: \$\{\{ vars.TECH_BRIEF_AUTOMATION \}\}/,
    );
});

test("no workflow can be started by untrusted events, and none rewrites history", () => {
  for (const [name, text] of Object.entries(WORKFLOWS)) {
    for (const event of [
      "pull_request_target",
      "workflow_run",
      "issue_comment",
      "repository_dispatch",
    ])
      assert.ok(
        !new RegExp(`^\\s+${event}:`, "m").test(top(text)),
        `${name}: ${event}`,
      );
    for (const forbidden of ["--force", "push -f", "persist-credentials: true"])
      assert.ok(!text.includes(forbidden), `${name}: ${forbidden}`);
  }
  assert.match(
    top(WORKFLOWS.research),
    /on:\n {2}schedule:[\s\S]*workflow_dispatch:/,
  );
  assert.match(
    top(WORKFLOWS.publish),
    /on:\n {2}schedule:[\s\S]*workflow_dispatch:/,
  );
  assert.match(top(WORKFLOWS.rehearsal), /on:\n {2}workflow_dispatch:/);
  assert.ok(!top(WORKFLOWS.rehearsal).includes("schedule:"));
  // Only main is ever pushed to, without force; ledger pushes happen in automation.mjs.
  const pushes =
    Object.values(WORKFLOWS)
      .flatMap((t) => runScripts(t))
      .join("\n")
      .match(/git push[^\n]*/g) ?? [];
  assert.deepEqual(pushes, ["git push origin HEAD:main"]);
});

test("permissions: none by default, and each job gets only what it needs", () => {
  for (const name of ["research", "publish", "preview", "rehearsal"])
    assert.match(top(WORKFLOWS[name]), /\npermissions: \{\}\n/, name);
  assert.match(top(WORKFLOWS.ci), /\npermissions:\n {2}contents: read\n/);
  const writes = [];
  for (const [workflow, text] of Object.entries(WORKFLOWS))
    for (const [job, body] of Object.entries(jobs(text))) {
      for (const scope of [
        "contents: write",
        "issues: write",
        "actions: read",
        "actions: write",
        "id-token: write",
        "pull-requests: write",
      ])
        if (body.includes(scope)) writes.push(`${workflow}.${job} ${scope}`);
      assert.ok(
        !/permissions: write-all|permissions: read-all/.test(body),
        `${workflow}.${job}`,
      );
    }
  assert.deepEqual(writes.sort(), [
    "preview.preview actions: read",
    "publish.alert issues: write",
    "publish.publish actions: read",
    "publish.publish contents: write",
    "rehearsal.verify actions: read",
    "research.alert issues: write",
    "research.reserve contents: write",
    "research.settle contents: write",
  ]);
});

test("secrets: the OpenAI key only in Saturday research; the artifact key only there, in Sunday publish and in the preview", () => {
  const uses = [];
  for (const [workflow, text] of Object.entries(WORKFLOWS))
    for (const [job, body] of Object.entries(jobs(text)))
      for (const m of body.matchAll(/secrets\.([A-Z_]+)/g))
        uses.push(`${workflow}.${job} ${m[1]}`);
  assert.deepEqual([...new Set(uses)].sort(), [
    "preview.preview TECH_BRIEF_ARTIFACT_KEY",
    "preview.preview TECH_BRIEF_ARTIFACT_KEY_PREVIOUS",
    "preview.preview TECH_BRIEF_CORRECTIONS",
    "publish.publish TECH_BRIEF_ARTIFACT_KEY",
    "publish.publish TECH_BRIEF_ARTIFACT_KEY_PREVIOUS",
    "publish.publish TECH_BRIEF_CORRECTIONS",
    "research.research OPENAI_API_KEY",
    "research.research TECH_BRIEF_ARTIFACT_KEY",
  ]);
  const environments = [];
  for (const [workflow, text] of Object.entries(WORKFLOWS))
    for (const [job, body] of Object.entries(jobs(text)))
      for (const m of body.matchAll(/environment: ([a-z-]+)/g))
        environments.push(`${workflow}.${job} ${m[1]}`);
  assert.deepEqual(environments.sort(), [
    "preview.preview tech-brief-publish",
    "publish.publish tech-brief-publish",
    "research.research tech-brief-research",
  ]);
  // Jobs holding a key never keep Git credentials, except publish, which must push main.
  assert.match(jobs(WORKFLOWS.research).research, /persist-credentials: false/);
  const preview = jobs(WORKFLOWS.preview).preview;
  assert.equal(
    (preview.match(/persist-credentials: false/g) ?? []).length,
    (preview.match(/uses: actions\/checkout@/g) ?? []).length,
  );
  assert.ok(!WORKFLOWS.rehearsal.includes("secrets."));
  assert.ok(!WORKFLOWS.ci.includes("secrets."));
});

test("actions are pinned to full commit SHAs of the reviewed versions", () => {
  for (const [name, text] of Object.entries(WORKFLOWS))
    for (const m of text.matchAll(/uses: ([^\s@]+)@(\S+)/g)) {
      assert.ok(
        Object.hasOwn(PINNED, m[1]),
        `${name}: unexpected action ${m[1]}`,
      );
      assert.equal(m[2], PINNED[m[1]], `${name}: ${m[1]} must be pinned`);
    }
});

test("schedules use America/New_York and the recommended trigger times", () => {
  const crons = (text) =>
    [
      ...text.matchAll(/- cron: "([^"]+)"\n\s+timezone: "America\/New_York"/g),
    ].map((m) => m[1]);
  assert.deepEqual(crons(WORKFLOWS.research), RECOMMENDED_TRIGGERS.research);
  assert.deepEqual(crons(WORKFLOWS.publish), RECOMMENDED_TRIGGERS.publication);
  // Every cron has a time zone.
  for (const text of [WORKFLOWS.research, WORKFLOWS.publish])
    assert.equal((text.match(/- cron:/g) ?? []).length, crons(text).length);
  for (const name of ["research", "publish"]) {
    assert.match(
      top(WORKFLOWS[name]),
      /concurrency:\n {2}group: tech-brief\n {2}cancel-in-progress: false/,
      name,
    );
  }
});

test("scripts never interpolate expressions directly, and production jobs check out main", () => {
  for (const [name, text] of Object.entries(WORKFLOWS))
    for (const script of runScripts(text))
      assert.ok(!script.includes("${{"), `${name}: ${script.slice(0, 60)}`);
  for (const job of ["plan", "reserve", "research", "settle"])
    assert.match(jobs(WORKFLOWS.research)[job], /ref: main\n/, job);
  for (const job of ["publish", "verify-live"])
    assert.match(jobs(WORKFLOWS.publish)[job], /ref: main\n/, job);
  assert.match(jobs(WORKFLOWS.preview).preview, /ref: main\n/);
});

test("artifacts: encrypted bundle only, immutable, with the intended retention", () => {
  const research = jobs(WORKFLOWS.research).research;
  assert.match(research, /path: \$\{\{ steps.seal.outputs.path \}\}/);
  assert.match(research, /retention-days: 90/);
  assert.match(research, /overwrite: false/);
  assert.match(
    research,
    /if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/research"/,
  );
  assert.equal((WORKFLOWS.research.match(/upload-artifact@/g) ?? []).length, 1);
  assert.match(jobs(WORKFLOWS.publish).publish, /digest-mismatch: error/);
  assert.match(WORKFLOWS.rehearsal, /retention-days: 1/);
  assert.ok(!WORKFLOWS.publish.includes("upload-artifact"));
  // The preview uploads only the encrypted preview file, for one day.
  const preview = jobs(WORKFLOWS.preview).preview;
  assert.equal((preview.match(/upload-artifact@/g) ?? []).length, 1);
  assert.match(
    preview,
    /if: steps\.preview\.outputs\.status == 'checked'\n\s+uses: actions\/upload-artifact@/,
  );
  assert.match(preview, /path: \$\{\{ steps\.preview\.outputs\.path \}\}/);
  assert.match(preview, /retention-days: 1\n/);
  assert.match(preview, /overwrite: false/);
  assert.match(preview, /digest-mismatch: error/);
  assert.match(
    preview,
    /if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/bundle" "\$RUNNER_TEMP\/preview"/,
  );
});

test("editorial preview: manual, read-only, no OpenAI key; supervised publication passes the approved digest", () => {
  const text = WORKFLOWS.preview;
  const preview = jobs(text).preview;
  assert.deepEqual(Object.keys(jobs(text)), ["preview"]);
  // Dispatch only, and never queued with (or replacing) research or publication runs.
  assert.match(top(text), /on:\n {2}workflow_dispatch:\n/);
  assert.ok(!top(text).includes("schedule:"));
  assert.match(
    top(text),
    /concurrency:\n {2}group: tech-brief-preview\n {2}cancel-in-progress: false/,
  );
  // Read-only token: exactly these two scopes.
  assert.match(
    preview,
    /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {4}steps:/,
  );
  for (const forbidden of [
    ": write",
    "write-all",
    "git push",
    "git commit",
    "git add",
    "OPENAI",
    "gh issue",
    "sunday-prepare",
    "check-changes",
  ])
    assert.ok(!text.includes(forbidden), forbidden);
  assert.match(
    preview,
    /TECH_BRIEF_REVIEWER_PUBLIC_KEY: \$\{\{ vars\.TECH_BRIEF_REVIEWER_PUBLIC_KEY \}\}/,
  );
  // Every step after planning needs the planner's "production" decision.
  const steps = preview.split(/\n {6}- /).slice(1);
  const gated = steps.filter((s) =>
    s.includes("if: steps.plan.outputs.run == 'production'"),
  );
  assert.equal(gated.length, 4);
  for (const name of [
    "automation.mjs resolve",
    "gh api",
    "download-artifact",
    "automation.mjs preview",
  ])
    assert.ok(
      gated.some((s) => s.includes(name)),
      name,
    );
  // Publication: the approved digest reaches preparation and the commit check,
  // with the activation state that decides whether it is required.
  const publish = jobs(WORKFLOWS.publish).publish;
  assert.match(top(WORKFLOWS.publish), /\n {6}approved_digest:\n/);
  const count = (re) => (publish.match(re) ?? []).length;
  assert.equal(
    count(/APPROVED_DIGEST: \$\{\{ inputs\.approved_digest \}\}/g),
    2,
  );
  assert.equal(
    count(/TECH_BRIEF_AUTOMATION: \$\{\{ vars\.TECH_BRIEF_AUTOMATION \}\}/g),
    3,
  );
  assert.match(
    publish,
    /sunday-prepare [^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*--approved-digest "\$APPROVED_DIGEST"(?: \\)?\n/,
  );
  assert.match(
    publish,
    /check-changes --repo-dir \. --edition "\$EDITION" --approved-digest "\$APPROVED_DIGEST"\n/,
  );
});

test("editorial corrections: opt-in per manual dispatch, digest-bound, decoded privately and always removed", () => {
  for (const name of ["preview", "publish"]) {
    const text = WORKFLOWS[name];
    const job = jobs(text)[name];
    // Opt-in inputs: a boolean that defaults to false, and the expected digest.
    assert.match(
      top(text),
      /\n {6}use_corrections:\n {8}description: [^\n]+\n {8}type: boolean\n {8}required: false\n {8}default: false\n/,
      name,
    );
    assert.match(top(text), /\n {6}corrections_digest:\n/, name);
    // The secret reaches exactly one step, and only when use_corrections is true.
    const steps = job.split(/\n {6}- /).slice(1);
    const holders = steps.filter((s) =>
      s.includes("secrets.TECH_BRIEF_CORRECTIONS"),
    );
    assert.equal(holders.length, 1, name);
    const [step] = holders;
    assert.equal(
      (text.match(/secrets\.TECH_BRIEF_CORRECTIONS/g) ?? []).length,
      1,
    );
    assert.match(
      step,
      /\n {10}TECH_BRIEF_CORRECTIONS: \$\{\{ inputs\.use_corrections && secrets\.TECH_BRIEF_CORRECTIONS \|\| '' \}\}\n/,
    );
    assert.match(step, /USE_CORRECTIONS: \$\{\{ inputs\.use_corrections \}\}/);
    assert.match(
      step,
      /CORRECTIONS_DIGEST: \$\{\{ inputs\.corrections_digest \}\}/,
    );
    // Decoded into a private temporary folder, removed on exit, and never passed on to node.
    const [script] = runScripts(step);
    assert.match(script, /if \[ "\$USE_CORRECTIONS" = "true" \]; then\n/);
    assert.match(script, /trap 'rm -rf "\$RUNNER_TEMP\/corrections"' EXIT\n/);
    assert.match(
      script,
      /\(umask 077 && mkdir -p "\$RUNNER_TEMP\/corrections" && printf '%s' "\$TECH_BRIEF_CORRECTIONS" \| base64 --decode > "\$CORRECTIONS_FILE"\)\n/,
    );
    assert.ok(
      script.indexOf("unset TECH_BRIEF_CORRECTIONS") < script.indexOf("node "),
    );
    assert.match(
      script,
      /--use-corrections "\$USE_CORRECTIONS" --corrections "\$CORRECTIONS_FILE" --corrections-digest "\$CORRECTIONS_DIGEST"\n/,
    );
    // Nothing prints, uploads or caches the corrections.
    for (const s of runScripts(text))
      for (const leak of [
        /echo[^\n]*CORRECTIONS/,
        /cat [^\n]*corrections/,
        /set -x/,
        /GITHUB_STEP_SUMMARY/,
      ])
        assert.ok(!leak.test(s), `${name}: ${leak}`);
    assert.ok(!/path:[^\n]*corrections/.test(text), name);
    assert.ok(!text.includes("actions/cache"), name);
    // Always removed, even when an earlier step failed.
    assert.match(
      job,
      /if: always\(\)\n\s+run: rm -rf [^\n]*"\$RUNNER_TEMP\/corrections"\n/,
      name,
    );
  }
  // Publication records the applied corrections digest in the commit message (a digest, never text).
  const publish = jobs(WORKFLOWS.publish).publish;
  assert.match(
    publish,
    /APPLIED_CORRECTIONS: \$\{\{ steps\.prepare\.outputs\.corrections_digest \}\}/,
  );
  assert.match(
    publish,
    /MESSAGE="\$MESSAGE \(editorial corrections \$APPLIED_CORRECTIONS\)"/,
  );
  // Research, rehearsal and CI never see corrections.
  for (const name of ["research", "rehearsal", "ci"])
    assert.ok(!/corrections/i.test(WORKFLOWS[name]), name);
});
