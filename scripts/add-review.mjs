#!/usr/bin/env node
// Adds an accepted BrainChain review to reviews/<owner>/<slug>/<version>.json.
//   node scripts/add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order> [--publisher-tasks <ids>]
// The release dir holds the files as ClawHub serves them; the order is the desk order the review was paid with.
// --publisher-tasks marks a review the skill's publisher ordered (scripts/ordered.mjs passes it), with the ids of
// every task on the board that ordered one for this release. Every cited line is checked against the files first.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseHash } from "../gate/brainchain-review-gate.mjs";
import { acceptedResult, citationProblems, publisherOrder, pythonNames } from "./accepted.mjs";
import { readRelease } from "./briefs.mjs";

const argv = process.argv.slice(2);
const flag = argv.indexOf("--publisher-tasks");
const tasks = flag >= 0 ? argv.splice(flag, 2)[1]?.split(",").map(Number) : undefined;
if (tasks && !tasks.every((id) => Number.isInteger(id) && id >= 0)) {
  console.error("--publisher-tasks takes task ids separated by commas");
  process.exit(1);
}
const [dir, release, version, network, order] = argv;
const [owner, slug] = release?.split("/") ?? [];
if (!dir || !owner || !slug || !version || !["testnet", "mainnet"].includes(network) || !order) {
  console.error("usage: add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order>");
  process.exit(1);
}
const accepted = await acceptedResult(network, order);
const parsed = pythonNames(accepted.code, ["summary", "findings"]);
const problems = citationProblems(dir, parsed.findings.map((f, i) => [`finding ${i}`, f]));
if (problems.length) throw new Error(`the review's citations do not hold against the release:\n${problems.join("\n")}`);

const review = {
  release: { registry: "clawhub", owner, slug, version },
  files: releaseHash(dir),
  network,
  board: accepted.board,
  task: accepted.task,
  order,
  record: accepted.record,
  verify: accepted.verify,
  ...(tasks ? { orderedBy: publisherOrder(network, accepted.status, readRelease(dir, { skip: ["_meta.json"] }), "ClawHub", tasks) } : {}),
  summary: parsed.summary,
  findings: parsed.findings.map(({ ruleId, severity, file, line, message }) => ({ ruleId, severity, file, line, message })),
  reviewedAt: new Date().toISOString().slice(0, 10),
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reviews", owner, slug, `${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
console.log(`${out}: ${review.findings.length} findings, files ${review.files}${review.orderedBy ? `, ordered by the publisher (${review.orderedBy.checked ? "checked" : "not checked"})` : ""}`);
