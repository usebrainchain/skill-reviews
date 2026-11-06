#!/usr/bin/env node
// Adds an accepted BrainChain review to reviews/<owner>/<slug>/<version>.json.
//   node scripts/add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order>
// The release dir holds the files as ClawHub serves them; the order is the desk order the review was paid with.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseHash } from "../gate/brainchain-review-gate.mjs";

const [dir, release, version, network, order] = process.argv.slice(2);
const [owner, slug] = release?.split("/") ?? [];
if (!dir || !owner || !slug || !version || !["testnet", "mainnet"].includes(network) || !order) {
  console.error("usage: add-review.mjs <release dir> <owner/slug> <version> <testnet|mainnet> <order>");
  process.exit(1);
}
const desk = network === "mainnet" ? "https://brain.usebrainchain.com" : "https://brain.testnet.usebrainchain.com";
// An accepted result is released a little after the grade, so read until its text is there (up to 15 minutes).
let status, code;
for (let attempt = 0; attempt < 30 && !code; attempt++) {
  if (attempt) await new Promise((r) => setTimeout(r, 30_000));
  status = await (await fetch(`${desk}/x402/tasks/${order}`)).json();
  if (!status.task?.accepted || !status.result) continue;
  const result = await (await fetch(status.result)).text();
  code = /```python\r?\n([\s\S]*?)```/.exec(result)?.[1];
}
if (!status?.task?.accepted || !status.result) throw new Error(`order ${order} has no accepted result`);
if (!code) throw new Error("the result has no python block after 15 minutes");

// The result is Python literals; read them without running anything.
const parsed = JSON.parse(execFileSync("python3", ["-I", "-c", `
import ast, json, sys
names = {}
for node in ast.parse(sys.stdin.read()).body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        names[node.targets[0].id] = ast.literal_eval(node.value)
print(json.dumps({"summary": names["summary"], "findings": names["findings"]}))
`], { input: code }).toString());

const review = {
  release: { registry: "clawhub", owner, slug, version },
  files: releaseHash(dir),
  network,
  task: Number(status.taskId),
  order,
  record: status.result,
  verify: `npx brainchain-verify ${network} --task ${status.taskId}`,
  summary: parsed.summary,
  findings: parsed.findings.map(({ ruleId, severity, file, line, message }) => ({ ruleId, severity, file, line, message })),
  reviewedAt: new Date().toISOString().slice(0, 10),
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reviews", owner, slug, `${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
console.log(`${out}: ${review.findings.length} findings, files ${review.files}`);
