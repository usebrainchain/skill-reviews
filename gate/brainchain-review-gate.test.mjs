import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decide, releaseHash } from "./brainchain-review-gate.mjs";

const release = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  return dir;
};
const request = (dir) => ({ sourcePath: dir, origin: { type: "clawhub", ownerHandle: "acme", slug: "tool", version: "1.0.0" } });
const review = (dir, findings) => async () => ({ files: releaseHash(dir), summary: "s", record: "https://example.test/r.txt", findings });
const finding = (severity, ruleId = "wallet-key") => ({ ruleId, severity, file: "SKILL.md", line: 3, message: "m" });

test("info findings only: allow, with the findings", async () => {
  const dir = release({ "SKILL.md": "a" });
  const out = await decide(request(dir), review(dir, [finding("info", "outbound-host")]));
  assert.equal(out.decision, "allow");
  assert.equal(out.protocolVersion, 1);
  assert.equal(out.findings[0].ruleId, "brainchain/outbound-host");
});

test("a warning or critical finding: warn with counts and the record", async () => {
  const dir = release({ "SKILL.md": "a" });
  const out = await decide(request(dir), review(dir, [finding("critical"), finding("warn")]));
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /2 findings, 1 critical\. Review: https:\/\/example\.test\/r\.txt/);
});

test("code downloaded or decoded and run: block", async () => {
  const dir = release({ "SKILL.md": "a" });
  assert.equal((await decide(request(dir), review(dir, [finding("critical", "pipe-to-shell")]))).decision, "block");
});

test("files that differ from the reviewed ones: warn", async () => {
  const reviewed = release({ "SKILL.md": "a" });
  const staged = release({ "SKILL.md": "b" });
  const out = await decide(request(staged), review(reviewed, [finding("info")]));
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /differ/);
});

test("ClawHub's _meta.json is not part of the hash", () => {
  assert.equal(releaseHash(release({ "SKILL.md": "a" })), releaseHash(release({ "SKILL.md": "a", "_meta.json": "{}" })));
});

test("no review, no ClawHub origin, or no index: warn, never block", async () => {
  const dir = release({ "SKILL.md": "a" });
  assert.match((await decide(request(dir), async () => undefined)).reason, /No BrainChain review/);
  assert.match((await decide({ sourcePath: dir, origin: { type: "git" } })).reason, /Not a ClawHub release/);
  const down = await decide(request(dir), async () => { throw new Error("timeout"); });
  assert.equal(down.decision, "warn");
});
