#!/usr/bin/env node
// Adds an accepted BrainChain review to reviews/<owner>/<slug>/<version>.json.
//   node scripts/add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order>
// The release dir holds the files as ClawHub serves them; the order is the desk order the review was paid with.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseHash } from "../gate/brainchain-review-gate.mjs";
import { acceptedResult, pythonNames } from "./accepted.mjs";

const [dir, release, version, network, order] = process.argv.slice(2);
const [owner, slug] = release?.split("/") ?? [];
if (!dir || !owner || !slug || !version || !["testnet", "mainnet"].includes(network) || !order) {
  console.error("usage: add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order>");
  process.exit(1);
}
const accepted = await acceptedResult(network, order);
const parsed = pythonNames(accepted.code, ["summary", "findings"]);

const review = {
  release: { registry: "clawhub", owner, slug, version },
  files: releaseHash(dir),
  network,
  board: accepted.board,
  task: accepted.task,
  order,
  record: accepted.record,
  verify: accepted.verify,
  summary: parsed.summary,
  findings: parsed.findings.map(({ ruleId, severity, file, line, message }) => ({ ruleId, severity, file, line, message })),
  reviewedAt: new Date().toISOString().slice(0, 10),
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reviews", owner, slug, `${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
console.log(`${out}: ${review.findings.length} findings, files ${review.files}`);
