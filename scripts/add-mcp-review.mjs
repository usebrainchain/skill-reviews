#!/usr/bin/env node
// Adds an accepted BrainChain review of an MCP server release to mcp/<registry>/<package>/<version>.json.
//   node scripts/add-mcp-review.mjs <release dir> <npm|pypi>:<package> <version> <testnet|mainnet> <order> <artifact>
//     [--publisher-tasks <ids>]
// The release dir holds the package's files as the registry serves them, unpacked (for npm, the contents of
// package/). The artifact names the exact download: npm's dist.integrity, or the sha256 of the PyPI file.
// --publisher-tasks marks a review the server's publisher ordered (scripts/ordered.mjs passes it), with the ids of
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
const [dir, release, version, network, order, artifact] = argv;
const [registry, name] = /^(npm|pypi):(.+)$/.exec(release ?? "")?.slice(1) ?? [];
if (!dir || !registry || !version || !["testnet", "mainnet"].includes(network) || !order || !artifact) {
  console.error("usage: add-mcp-review.mjs <release dir> <npm|pypi>:<package> <version> <testnet|mainnet> <order> <artifact>");
  process.exit(1);
}
const accepted = await acceptedResult(network, order);
const parsed = pythonNames(accepted.code, ["summary", "tools", "permissions", "findings"]);
const problems = citationProblems(dir, [...parsed.tools.map((t) => [`tool ${t.name}`, t]), ...parsed.findings.map((f, i) => [`finding ${i}`, f])]);
if (problems.length) throw new Error(`the review's citations do not hold against the release:\n${problems.join("\n")}`);

const review = {
  release: { registry, name, version, artifact },
  files: releaseHash(dir),
  network,
  board: accepted.board,
  task: accepted.task,
  order,
  record: accepted.record,
  verify: accepted.verify,
  ...(tasks ? { orderedBy: publisherOrder(network, accepted.status, readRelease(dir), registry === "npm" ? "npm" : "PyPI", tasks) } : {}),
  summary: parsed.summary,
  tools: parsed.tools.map(({ name, file, line, reach, untrusted_output, note }) => ({ name, file, line, reach, untrustedOutput: untrusted_output, note })),
  permissions: parsed.permissions,
  findings: parsed.findings.map(({ ruleId, severity, file, line, message }) => ({ ruleId, severity, file, line, message })),
  reviewedAt: new Date().toISOString().slice(0, 10),
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp", registry, ...name.split("/"), `${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
console.log(`${out}: ${review.tools.length} tools, ${review.findings.length} findings, files ${review.files}${review.orderedBy ? `, ordered by the publisher (${review.orderedBy.checked ? "checked" : "not checked"})` : ""}`);
