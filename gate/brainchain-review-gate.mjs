#!/usr/bin/env node
// An OpenClaw install policy (security.installPolicy) that looks up BrainChain's review of the
// ClawHub release being installed. It reads OpenClaw's request on stdin and answers on stdout.
//
//   reviewed, files match, only info findings   -> allow, with the findings
//   reviewed, files match, warn or critical     -> warn, with the findings (the operator acknowledges)
//   a finding that downloads or decodes and runs code -> block
//   no review, files differ or not passed, lookup failed, not from ClawHub -> warn, saying which
//   a review whose hash leaves out hidden files (sha256:) -> warn at most, even when the files match
//
// It never blocks for lack of a review or a network error, and it needs nothing but Node 22.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = process.env.BRAINCHAIN_REVIEWS_URL ?? "https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/reviews";
const BLOCKING = new Set(["pipe-to-shell", "encoded-payload"]);
// ClawHub adds _meta.json to every download; it is not part of what the publisher wrote.
const SKIP = new Set(["_meta.json"]);

/**
 * sha256v2 over every file of a release, hidden ones included, but ClawHub's top-level _meta.json. Files go in the
 * byte order of their UTF-8 paths, and each adds its path's length, the path, its size and its bytes, both lengths
 * as 8-byte big-endian integers. Paths are relative to the release, with "/" between directories.
 */
export function releaseHash(dir) {
  const hash = createHash("sha256");
  const paths = filesIn(dir)
    .filter((p) => !SKIP.has(p))
    .map((p) => Buffer.from(p))
    .sort(Buffer.compare);
  for (const path of paths) {
    const bytes = readFileSync(join(dir, path.toString()));
    hash.update(length(path)).update(path).update(length(bytes)).update(bytes);
  }
  return `sha256v2:${hash.digest("hex")}`;
}

const length = (bytes) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(bytes.length));
  return out;
};

// Every file under dir, by "/"-separated relative path. A link's target can sit outside the release, where no review
// reached, so a link is an error rather than something to follow.
function filesIn(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
    if (entry.isDirectory()) return filesIn(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

/** The first format, "sha256:", left out hidden files. Reviews published with it are still read, never written. */
export function legacyReleaseHash(dir) {
  const hash = createHash("sha256");
  const paths = filesIn(dir)
    .filter((p) => !p.split("/").some((part) => part.startsWith(".")) && !SKIP.has(p))
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
  if (!request.sourcePath || request.sourcePathKind !== "directory") {
    return answer("warn", `OpenClaw did not pass the files of ${release} as a directory, so they were not compared with the reviewed ones.`);
  }
  const v2 = review.files?.startsWith("sha256v2:");
  let files;
  try {
    files = (v2 ? releaseHash : legacyReleaseHash)(request.sourcePath);
  } catch (error) {
    return answer("warn", `Could not hash the files of ${release} (${error.message}).`);
  }
  if (files !== review.files) return answer("warn", `The files of ${release} differ from the ones BrainChain reviewed.`);
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
  if (!v2 || review.findings.some((f) => f.severity !== "info")) {
    const critical = review.findings.filter((f) => f.severity === "critical").length;
    const counts = `${review.findings.length} findings${critical ? `, ${critical} critical` : ""}`;
    const hidden = v2 ? "" : " This review's file hash leaves out hidden files, so those were not compared.";
    return answer("warn", `BrainChain reviewed ${release}: ${counts}.${hidden} ${link}`, findings);
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
