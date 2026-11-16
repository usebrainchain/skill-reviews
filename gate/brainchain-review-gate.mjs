#!/usr/bin/env node
// An OpenClaw install policy (security.installPolicy) that checks the ClawHub release being installed against
// BrainChain's review of it. It reads OpenClaw's request on stdin and answers on stdout:
//
//   reviewed, files match, info findings only            -> allow, with the findings
//   reviewed, files match, warn or critical findings     -> warn, with the findings, for the operator to approve
//   code downloaded or decoded and run, at any severity  -> block
//   an older review whose hash leaves out hidden files   -> warn at most, naming the hidden files the release has
//   a bare slug that more than one publisher uses        -> warn, asking for an @owner/slug install
//   no review, files differ or missing, lookup failed    -> warn, saying which
//   not from ClawHub                                     -> warn
//
// It never blocks for lack of a review or a network error, and it needs nothing but Node 22.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = "https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/reviews";
const CLAWHUB = "https://clawhub.ai";
const BLOCKING = new Set(["pipe-to-shell", "encoded-payload"]);
// ClawHub adds _meta.json to every download; it is not part of what the publisher wrote.
const SKIP = new Set(["_meta.json"]);
// OpenClaw blocks outright a warning with more than 100 findings, or one whose notice runs past 4,000 characters. The
// notice is its title, the skill's name, the reason, a line per finding and its recovery guidance; the frame is the
// title and guidance, under 500 characters, plus room for the note that says how many findings were left out.
const MAX_FINDINGS = 100;
const NOTICE_CHARS = 4_000;
const NOTICE_FRAME = 700;
const SEVERITY = { critical: 0, warn: 1, info: 2 };
// How many hidden files an older review's warning names before it says how many more there are.
const HIDDEN_NAMED = 5;

/**
 * sha256v2 over every file of a release, hidden ones included, except ClawHub's top-level _meta.json. Files go in the
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
// reached, so a link is an error.
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

// The hidden files and directories of a release, outermost only: ".hooks/" stands for everything under it.
function hiddenIn(dir) {
  const hidden = new Set();
  for (const path of filesIn(dir)) {
    const parts = path.split("/");
    const at = parts.findIndex((part) => part.startsWith("."));
    if (at >= 0) hidden.add(parts.slice(0, at + 1).join("/") + (at < parts.length - 1 ? "/" : ""));
  }
  return [...hidden].sort();
}

// What an older review's warning says about the hidden files its hash did not cover.
function uncovered(hidden) {
  if (!hidden.length) return "This review's file hash leaves out hidden files; this release has none.";
  const named = hidden.slice(0, HIDDEN_NAMED).map((path) => (path.length > 80 ? `…${path.slice(-79)}` : path));
  const more = hidden.length > named.length ? ` and ${hidden.length - named.length} more` : "";
  return `This review's file hash leaves out hidden files, so these were not compared: ${named.join(", ")}${more}.`;
}

const answer = (decision, reason, findings = []) => ({ protocolVersion: 1, decision, ...(reason ? { reason } : {}), findings });

// Characters OpenClaw prints for text: newlines and tabs become two, other control characters none.
const width = (text) => String(text).replace(/\p{Cc}/gu, "  ").length;
// A finding as OpenClaw prints it: "    • [WARN] rule: message (file:line)" and a newline.
const findingWidth = (f) =>
  12 + width(f.severity) + width(f.ruleId) + width(f.message) + (f.file ? width(f.file) + 3 + (f.line ? String(f.line).length + 1 : 0) : 0);

/** The most severe findings that fit OpenClaw's notice, and a reason that says when some were left out. */
function fit(reason, findings, name) {
  const sorted = [...findings].sort((a, b) => (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3));
  let room = NOTICE_CHARS - NOTICE_FRAME - width(name) - width(reason ?? "");
  const kept = [];
  for (const f of sorted) {
    room -= findingWidth(f);
    if (kept.length === MAX_FINDINGS || room < 0) break;
    kept.push(f);
  }
  const more = kept.length < findings.length ? ` Showing ${kept.length} of ${findings.length} findings; the review lists all of them.` : "";
  return [reason && `${reason}${more}`, kept];
}

/** ClawHub has several skills by the slug, so it cannot say whose release a bare-slug install is. */
class AmbiguousSlug extends Error {}

export async function decide(request, fetchReview = fetchFromIndex, fetchOwner = fetchOwnerFromRegistry) {
  const origin = request.origin ?? {};
  if (origin.type !== "clawhub" || !origin.slug || !origin.version) {
    return answer("warn", "Not a ClawHub release, so BrainChain has no review of it.");
  }
  let release = `${origin.slug} ${origin.version}`;
  let review;
  try {
    // OpenClaw names the owner only for an owner-qualified install (@owner/slug). For a bare slug the registry chose
    // the publisher, so ask it which one. Either way, the file hash below is what ties a review to these files.
    const owner = origin.ownerHandle ?? (await fetchOwner(origin.registry ?? CLAWHUB, origin.slug));
    release = `${owner}/${release}`;
    review = await fetchReview(owner, origin.slug, origin.version);
  } catch (error) {
    if (error instanceof AmbiguousSlug) {
      return answer(
        "warn",
        `ClawHub has more than one skill called ${origin.slug}, so BrainChain cannot tell whose review applies and the release is unchecked. Install it as @owner/${origin.slug}, using the publisher's ClawHub handle, to have it checked.`,
      );
    }
    return answer("warn", `Could not look up BrainChain's review of ${release} (${error.message}), so the release is unchecked.`);
  }
  if (!review) return answer("warn", `No BrainChain review of ${release} yet.`);
  if (!request.sourcePath || request.sourcePathKind !== "directory") {
    return answer("warn", `OpenClaw did not pass the files of ${release} as a directory, so they were not compared with the reviewed ones.`);
  }
  const v2 = review.files?.startsWith("sha256v2:");
  let files;
  let hidden;
  try {
    files = (v2 ? releaseHash : legacyReleaseHash)(request.sourcePath);
    if (!v2) hidden = hiddenIn(request.sourcePath);
  } catch (error) {
    return answer("warn", `Could not hash the files of ${release} (${error.message}), so they were not compared with the reviewed ones.`);
  }
  if (files !== review.files) return answer("warn", `The files of ${release} differ from the ones BrainChain reviewed.`);
  const findings = review.findings.map((f) => ({
    ruleId: `brainchain/${f.ruleId}`,
    severity: f.severity,
    message: f.message,
    ...(f.file ? { file: f.file } : {}),
    ...(f.line ? { line: f.line } : {}),
  }));
  const reply = (decision, reason) => answer(decision, ...fit(reason, findings, request.targetName ?? origin.slug));
  const link = `Review: ${review.record}`;
  if (review.findings.some((f) => BLOCKING.has(f.ruleId))) {
    return reply("block", `BrainChain's review of ${release} found code that is downloaded or decoded and run. ${link}`);
  }
  if (!v2 || review.findings.some((f) => f.severity !== "info")) {
    const critical = review.findings.filter((f) => f.severity === "critical").length;
    const total = review.findings.length;
    const counts = `${total} ${total === 1 ? "finding" : "findings"}${critical ? `, ${critical} critical` : ""}`;
    const note = v2 ? "" : ` ${uncovered(hidden)}`;
    return reply("warn", `BrainChain reviewed ${release}: ${counts}.${note} ${link}`);
  }
  return reply("allow");
}

// Each lookup gets 4 seconds, so both fit in the 10 seconds OpenClaw gives a policy by default.
async function fetchOwnerFromRegistry(registry, slug) {
  const response = await fetch(`${registry.replace(/\/+$/, "")}/api/v1/skills/${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status === 409 && (await response.json().catch(() => undefined))?.code === "AMBIGUOUS_SKILL_SLUG") {
    throw new AmbiguousSlug(`more than one skill is called ${slug}`);
  }
  if (!response.ok) throw new Error(`ClawHub answered ${response.status}`);
  const owner = (await response.json())?.owner?.handle;
  if (typeof owner !== "string" || !owner) throw new Error("ClawHub named no owner");
  return owner;
}

async function fetchFromIndex(owner, slug, version) {
  const response = await fetch(`${INDEX}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`, {
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`the review index answered ${response.status}`);
  return response.json();
}

// Node resolves symbolic links in this module's URL but not in argv[1], so when the gate runs from a linked path
// (/tmp on macOS) the two differ unless argv[1] is resolved too.
const invokedAs = () => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]);
  } catch {
    return undefined;
  }
};

if (fileURLToPath(import.meta.url) === invokedAs()) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try {
    result = await decide(JSON.parse(input));
  } catch (error) {
    result = answer("warn", `BrainChain's review check failed: ${error.message}`);
  }
  // A lookup that timed out can leave its connection attempt open for seconds, past OpenClaw's 10, so exit as soon as
  // the answer is written rather than when Node runs out of work.
  process.exitCode = 0;
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit());
}
