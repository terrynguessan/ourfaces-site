// Phase 4 rehearsal: exercises the real GitHub plumbing (artifact upload,
// download by id from another run, artifact and run-attempt records,
// provenance, decryption, publication preparation) with synthetic content,
// so it costs nothing, needs no secrets and cannot publish:
// - the research result is synthetic (three fixture stories, fixture pages);
// - it is sealed with the public REHEARSAL_KEY, which production refuses;
// - there is no ledger: a small plaintext handoff artifact (identifiers and
//   the digest only) stands in for the ledger handoff record;
// - publication is prepared with write: false in a temporary copy of the
//   content folder, with an in-memory approved copy of the source policy and
//   a simulated Sunday clock; nothing is written to the repository.
// Used by .github/workflows/tech-brief-rehearsal.yml: stage "seal", then
// stage "verify" with the seal run's id once that run has completed.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REHEARSAL_KEY, gitIsAncestor, singleFile } from "./automation.mjs";
import { sealBundle } from "./bundle.mjs";
import { buildEvidence, extractArticle } from "./html.mjs";
import {
  bundleArtifactName,
  openVerifiedBundle,
  verifyProvenance,
} from "./provenance.mjs";
import { preparePublication } from "./publish.mjs";
import { loadConfig } from "./research.mjs";
import { currentEdition, editionSchedule } from "./schedule.mjs";
import { addDays, loadSourcePolicy } from "./validate.mjs";

export const REHEARSAL_RUN_ID = "run-0000beef";
export const REHEARSAL_WORKFLOW_PATH =
  ".github/workflows/tech-brief-rehearsal.yml";
export const REHEARSAL_HANDOFF_ARTIFACT = "tech-brief-rehearsal-handoff";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("./test/fixtures/valid-edition.json", import.meta.url),
    "utf8",
  ),
);
const SOURCES = [
  {
    host: "news.rehearsal-alpha.example",
    site: "Rehearsal Source Alpha",
    story: FIXTURE.stories[0],
    paragraphs: [
      "Starting this week, every tier of the platform's API can return responses that are constrained by a developer-supplied JSON Schema.",
      "Before the change, only enterprise accounts could request schema-constrained output, and other customers had to validate and retry malformed replies themselves.",
      "The company said the decoder now refuses to emit tokens that would break the schema, so responses always parse.",
    ],
  },
  {
    host: "news.rehearsal-beta.example",
    site: "Rehearsal Source Beta",
    story: FIXTURE.stories[1],
    paragraphs: [
      "A team of researchers examined 1,200 open-source repositories to understand where intermittent test failures come from.",
      "They attributed 61% of the flaky failures they reproduced to fixtures that several tests shared and mutated in place.",
      "Projects that moved to per-test fixture copies saw the number of reruns in continuous integration fall noticeably over the following months.",
    ],
  },
  {
    host: "news.rehearsal-gamma.example",
    site: "Rehearsal Source Gamma",
    story: FIXTURE.stories[2],
    paragraphs: [
      "The 5.0 release of the command-line checker introduces an incremental mode that stores results from the previous run in a local cache.",
      "When incremental mode is on, the tool re-examines only files whose content changed and the modules that import them.",
      "On three large monorepos used for benchmarking, repeated checks after small edits completed up to four times faster.",
    ],
  },
];
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** A synthetic research result for `edition`, with the pages its stories cite. */
export function rehearsalResult(edition) {
  const pages = new Map();
  const stories = [];
  const candidates = [];
  SOURCES.forEach((source, i) => {
    const url = `https://${source.host}/rehearsal/story-${i + 1}`;
    const date = addDays(edition, -(i + 1));
    pages.set(
      url,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(source.story.sourceHeadline)}</title>
<meta property="og:title" content="${esc(source.story.sourceHeadline)}"><meta property="og:site_name" content="${esc(source.site)}">
<meta property="article:published_time" content="${date}T12:00:00Z"><link rel="canonical" href="${url}"></head>
<body><main><article><h1>${esc(source.story.sourceHeadline)}</h1>${source.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</article></main></body></html>`,
    );
    const claims = [0, 2].map((p, n) => ({
      id: `c${n + 1}`,
      text: `Synthetic rehearsal claim ${n + 1}`,
      quote: source.paragraphs[p],
      paragraphId: `p${p + 1}`,
      quoteFound: true,
      verdict: "entailed",
    }));
    stories.push({
      id: `s${i + 1}`,
      category: source.story.category,
      url,
      publisher: source.site,
      sourcePublishedOn: date,
      sourceHeadline: source.story.sourceHeadline,
      sourceHeadlineLang: "en",
      en: source.story.en,
      fr: source.story.fr,
      evidence: {
        verification: claims.map((c) => ({
          claimId: c.id,
          claim: c.text,
          quote: c.quote,
          paragraphId: c.paragraphId,
          usedInSummary: true,
        })),
        corroboratedBy: [],
        editorial: {
          contentType: "independent-reporting",
          technicalSubstance: "substantial",
          vendorSelfReport: false,
          attributedTo: null,
        },
      },
    });
    candidates.push({
      key: `k${i + 1}`,
      url,
      status: "selected",
      storyId: `s${i + 1}`,
      verification: { status: "verified", distinctSupported: 2, claims },
    });
  });
  const generation = {
    runId: REHEARSAL_RUN_ID,
    mode: "production",
    policyStatus: "approved",
    provisionalPolicyOverride: false,
    models: {},
    estimatedCostUsd: 0,
  };
  return {
    pages,
    draft: {
      schemaVersion: 1,
      edition,
      publishedOn: addDays(edition, 1),
      stories,
      generation,
    },
    report: {
      schema: "ourfaces-tech-brief-research-report/1",
      runId: REHEARSAL_RUN_ID,
      mode: "production",
      edition,
      status: "edition",
      candidates,
      selected: candidates.map((c) => c.key),
      validation: { ok: true, errors: [], warnings: [] },
      budget: { runTotalCountedUsd: 0 },
    },
  };
}

/** Serves the synthetic pages instead of the network. */
export const fixtureFetcher = (pages) => ({
  fetchArticle: async (url) => {
    const html = pages.get(url);
    if (!html) return { ok: false, code: "HTTP_STATUS", message: "HTTP 404" };
    const article = extractArticle(html);
    return {
      ok: true,
      requestedUrl: url,
      finalUrl: url,
      article,
      evidence: buildEvidence(article),
    };
  },
});

/** Ten minutes after the edition's publication opens: the rehearsal's simulated clock. */
export const rehearsalClock = (edition) =>
  new Date(editionSchedule(edition).publication.opens.getTime() + 10 * 60_000);

/**
 * Verify stage: provenance against the real GitHub records, decryption with
 * the rehearsal key, and publication preparation without writing.
 */
export async function rehearseSunday({
  handoff,
  artifact,
  run,
  expected,
  isMainCommit,
  bundleBytes,
  contentDir,
  now = new Date(),
}) {
  const verified = verifyProvenance({
    handoff,
    artifact,
    run,
    expected,
    isMainCommit,
    now,
  });
  const { report, draft } = openVerifiedBundle(bundleBytes, verified, [
    REHEARSAL_KEY,
  ]);
  // TEST-ONLY approved copy of the source policy, held in memory for synthetic content.
  const policy = {
    ...(await loadSourcePolicy(new URL("./sources.json", import.meta.url))),
    status: "approved",
  };
  const scratch = mkdtempSync(join(tmpdir(), "tech-brief-rehearsal-"));
  cpSync(contentDir, scratch, { recursive: true });
  return preparePublication({
    report,
    draft,
    policy,
    config: await loadConfig(),
    fetcher: fixtureFetcher(rehearsalResult(handoff.edition).pages),
    contentDir: scratch,
    now: rehearsalClock(handoff.edition),
    trigger: "manual",
    write: false,
  });
}

// CLI ------------------------------------------------------------------------------------------
// seal    --out-dir DIR
// handoff --out FILE --artifact-id N --bundle-digest HEX --edition YYYY-MM-DD
// verify  --handoff FILE --artifact-json F --run-json F --bundle-dir DIR
//         --content-dir DIR --repo-dir DIR --branch NAME
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const env = process.env;
  const emit = (code, value) => {
    if (env.GITHUB_OUTPUT)
      for (const [k, v] of Object.entries(value))
        if (v !== undefined && v !== null && typeof v !== "object")
          writeFileSync(
            env.GITHUB_OUTPUT,
            `${k}=${String(v).replace(/[\r\n]/g, " ")}\n`,
            { flag: "a" },
          );
    console.log(JSON.stringify(value));
    process.exit(code);
  };
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  try {
    if (command === "seal") {
      const edition = currentEdition(new Date());
      const { report, draft } = rehearsalResult(edition);
      const sealed = sealBundle({
        report,
        draft,
        workflow: env.GITHUB_WORKFLOW_REF,
        key: REHEARSAL_KEY,
      });
      mkdirSync(option("--out-dir"), { recursive: true });
      const path = join(option("--out-dir"), "rehearsal-bundle.bin");
      writeFileSync(path, sealed.bytes, { flag: "wx" });
      emit(0, {
        edition,
        path,
        bundle_digest: sealed.digest,
        artifact_name: bundleArtifactName(
          edition,
          env.GITHUB_RUN_ID,
          env.GITHUB_RUN_ATTEMPT,
        ),
      });
    } else if (command === "handoff") {
      const handoff = {
        reservationId: "rehearsal",
        edition: option("--edition"),
        kind: "manual",
        researchRunId: REHEARSAL_RUN_ID,
        workflowRunId: Number(env.GITHUB_RUN_ID),
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        artifactId: Number(option("--artifact-id")),
        bundleDigest: option("--bundle-digest"),
      };
      mkdirSync(join(option("--out"), ".."), { recursive: true });
      writeFileSync(option("--out"), `${JSON.stringify(handoff)}\n`, {
        flag: "wx",
      });
      emit(0, { handoff: true });
    } else if (command === "verify") {
      const handoff = readJson(option("--handoff"));
      const branch = option("--branch");
      const outcome = await rehearseSunday({
        handoff,
        artifact: readJson(option("--artifact-json")),
        run: readJson(option("--run-json")),
        expected: {
          repository: env.GITHUB_REPOSITORY,
          repositoryId: Number(env.GITHUB_REPOSITORY_ID),
          workflowPath: REHEARSAL_WORKFLOW_PATH,
          branch,
          events: ["workflow_dispatch"],
        },
        isMainCommit: (sha) =>
          gitIsAncestor(sha, `origin/${branch}`, { dir: option("--repo-dir") }),
        bundleBytes: readFileSync(singleFile(option("--bundle-dir"))),
        contentDir: option("--content-dir"),
      });
      emit(0, {
        status: outcome.status,
        edition: outcome.edition,
        dropped: outcome.dropped.length,
      });
    } else
      emit(1, {
        ok: false,
        code: "USAGE",
        message: "Commands: seal, handoff, verify",
      });
  } catch (error) {
    emit(4, {
      ok: false,
      code: error?.code ?? "ERROR",
      message: error?.code
        ? String(error.message).slice(0, 300)
        : "Unexpected failure",
    });
  }
}
