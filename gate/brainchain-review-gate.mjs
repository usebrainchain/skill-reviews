#!/usr/bin/env node
// An OpenClaw install policy (security.installPolicy) that looks up BrainChain's review of the
// ClawHub release being installed. It reads OpenClaw's request on stdin and answers on stdout.
//
//   reviewed, files match, only info findings   -> allow, with the findings
//   reviewed, files match, warn or critical     -> warn, with the findings (the operator acknowledges)
//   a finding that downloads or decodes and runs code -> block
//   no review, files differ, lookup failed, not from ClawHub -> warn, saying which
//
// It never blocks for lack of a review or a network error, and it needs nothing but Node 22.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = process.env.BRAINCHAIN_REVIEWS_URL ?? "https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/reviews";
const BLOCKING = new Set(["pipe-to-shell", "encoded-payload"]);
// ClawHub adds _meta.json to every download; it is not part of what the publisher wrote.
const SKIP = new Set(["_meta.json"]);

/** sha256 over every file of a release, by sorted path: "path\0bytes\0" for each. */
export function releaseHash(dir) {
  const hash = createHash("sha256");
  const paths = readdirSync(dir, { recursive: true })
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")) && !SKIP.has(p) && statSync(join(dir, p)).isFile())
    .sort();
  for (const path of paths) hash.update(`${path}\0`).update(readFileSync(join(dir, path))).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

const answer = (decision, reason, findings = []) => ({ protocolVersion: 1, decision, ...(reason ? { reason } : {}), findings });

export async function decide(request, fetchReview = fetchFromIndex) {
  const origin = request.origin ?? {};
  if (origin.type !== "clawhub" || !origin.ownerHandle || !origin.slug || !origin.version) {
    return answer("warn", "Not a ClawHub release, so BrainChain has no review of it.");
  }
  const release = `${origin.ownerHandle}/${origin.slug} ${origin.version}`;
  let review;
  try {
    review = await fetchReview(origin.ownerHandle, origin.slug, origin.version);
  } catch (error) {
    return answer("warn", `Could not reach BrainChain's reviews (${error.message}); ${release} is unchecked.`);
  }
  if (!review) return answer("warn", `No BrainChain review of ${release} yet.`);
  if (request.sourcePath && releaseHash(request.sourcePath) !== review.files) {
    return answer("warn", `The files of ${release} differ from the ones BrainChain reviewed.`);
  }
  const findings = review.findings.map((f) => ({
    ruleId: `brainchain/${f.ruleId}`,
    severity: f.severity,
    message: f.message,
    ...(f.file ? { file: f.file } : {}),
    ...(f.line ? { line: f.line } : {}),
  }));
  const link = `Review: ${review.record}`;
  if (review.findings.some((f) => f.severity === "critical" && BLOCKING.has(f.ruleId))) {
    return answer("block", `BrainChain's review of ${release} found code that is downloaded or decoded and run. ${link}`, findings);
  }
  if (review.findings.some((f) => f.severity !== "info")) {
    const critical = review.findings.filter((f) => f.severity === "critical").length;
    const counts = `${review.findings.length} findings${critical ? `, ${critical} critical` : ""}`;
    return answer("warn", `BrainChain reviewed ${release}: ${counts}. ${link}`, findings);
  }
  return answer("allow", undefined, findings);
}

async function fetchFromIndex(owner, slug, version) {
  const response = await fetch(`${INDEX}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`index answered ${response.status}`);
  return response.json();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try {
    result = await decide(JSON.parse(input));
  } catch (error) {
    result = answer("warn", `BrainChain's review check failed: ${error.message}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
