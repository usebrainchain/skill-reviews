import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { decide, legacyReleaseHash, releaseHash } from "./brainchain-review-gate.mjs";

const release = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};
const request = (dir) => ({
  sourcePath: dir,
  sourcePathKind: "directory",
  origin: { type: "clawhub", ownerHandle: "acme", slug: "tool", version: "1.0.0" },
});
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

test("code downloaded or decoded and run: block, at any severity", async () => {
  const dir = release({ "SKILL.md": "a" });
  for (const severity of ["critical", "warn", "info"]) {
    for (const rule of ["pipe-to-shell", "encoded-payload"]) {
      assert.equal((await decide(request(dir), review(dir, [finding(severity, rule)]))).decision, "block", `${severity} ${rule}`);
    }
  }
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

test("the hash is sha256v2 exactly as the README describes it", () => {
  const part = (text) => {
    const bytes = Buffer.from(text);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  const parts = [".env", "k", "SKILL.md", "a", "sub/_meta.json", "{}", "sub/x", ""].map(part);
  const expected = createHash("sha256").update(Buffer.concat(parts)).digest("hex");
  const dir = release({ "SKILL.md": "a", ".env": "k", "sub/x": "", "sub/_meta.json": "{}", "_meta.json": "{}" });
  assert.equal(releaseHash(dir), `sha256v2:${expected}`);
});

test("hidden files at any depth are part of the hash", () => {
  const base = releaseHash(release({ "SKILL.md": "a" }));
  assert.notEqual(releaseHash(release({ "SKILL.md": "a", ".postinstall.sh": "curl x | sh" })), base);
  assert.notEqual(releaseHash(release({ "SKILL.md": "a", "scripts/.hooks/run.sh": "x" })), base);
});

test("each path and file is length-prefixed, so one file cannot hash like two", () => {
  assert.notEqual(releaseHash(release({ a: "x\0b\0y" })), releaseHash(release({ a: "x", b: "y" })));
});

test("an added hidden file: the files differ, warn", async () => {
  const reviewed = release({ "SKILL.md": "a" });
  const staged = release({ "SKILL.md": "a", ".postinstall.sh": "curl x | sh" });
  const out = await decide(request(staged), review(reviewed, [finding("info")]));
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /differ/);
});

test("a review in the first hash format: warn even when the files match, since hidden files were left out", async () => {
  const dir = release({ "SKILL.md": "a", ".postinstall.sh": "x" });
  const legacy = (findings) => async () => ({ files: legacyReleaseHash(dir), record: "https://example.test/r.txt", findings });
  const out = await decide(request(dir), legacy([finding("info", "outbound-host")]));
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /1 findings\. This review's file hash leaves out hidden files/);
  assert.equal((await decide(request(dir), legacy([finding("critical", "pipe-to-shell")]))).decision, "block");
});

test("a symbolic link in the release: warn", async () => {
  const dir = release({ "SKILL.md": "a" });
  symlinkSync(tmpdir(), join(dir, "linked"));
  const out = await decide(request(dir), review(release({ "SKILL.md": "a" }), [finding("info")]));
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /linked is a symbolic link/);
});

test("no review, no ClawHub origin, or no index: warn, never block", async () => {
  const dir = release({ "SKILL.md": "a" });
  assert.match((await decide(request(dir), async () => undefined)).reason, /No BrainChain review/);
  assert.match((await decide({ sourcePath: dir, origin: { type: "git" } })).reason, /Not a ClawHub release/);
  const down = await decide(request(dir), async () => { throw new Error("timeout"); });
  assert.equal(down.decision, "warn");
});

test("no source directory to compare: warn, never allow", async () => {
  const dir = release({ "SKILL.md": "a" });
  for (const staged of [{ ...request(dir), sourcePath: undefined }, { ...request(dir), sourcePathKind: "file" }, { ...request(dir), sourcePathKind: undefined }]) {
    const out = await decide(staged, review(dir, [finding("info", "outbound-host")]));
    assert.equal(out.decision, "warn");
    assert.match(out.reason, /not compared/);
  }
});

// OpenClaw's example request from docs.openclaw.ai/tools/skills-config, as published: its origin names no owner.
const documented = JSON.parse(readFileSync(new URL("./fixtures/skill-install-request.json", import.meta.url), "utf8"));

test("OpenClaw's documented request: the owner comes from the registry it names", async () => {
  const dir = release({ "SKILL.md": "a" });
  const asked = [];
  const out = await decide(
    { ...documented, sourcePath: dir },
    async (...lookup) => {
      asked.push(["review", ...lookup]);
      return review(dir, [finding("info", "outbound-host")])();
    },
    async (...lookup) => {
      asked.push(["owner", ...lookup]);
      return "acme";
    },
  );
  assert.equal(out.decision, "allow");
  assert.deepEqual(asked, [["owner", "https://clawhub.openclaw.ai", "weather"], ["review", "acme", "weather", "1.0.0"]]);
});

test("an owner-qualified install names the owner, so the registry is not asked", async () => {
  const dir = release({ "SKILL.md": "a" });
  const out = await decide(request(dir), review(dir, [finding("info")]), async () => assert.fail("asked the registry"));
  assert.equal(out.decision, "allow");
});

test("the registry cannot say who publishes the slug: warn", async () => {
  const dir = release({ "SKILL.md": "a" });
  const out = await decide({ ...documented, sourcePath: dir }, review(dir, []), async () => {
    throw new Error("ClawHub answered 404");
  });
  assert.equal(out.decision, "warn");
  assert.match(out.reason, /weather 1\.0\.0 \(ClawHub answered 404\)/);
});

// OpenClaw's warning notice, as formatInstallPolicyNotice in openclaw 2026.11.4 renders it; past 4,000 characters it blocks.
const GUIDANCE = [
  "This invocation cannot approve install policy warnings.",
  "To continue:",
  "  • Run the matching direct `openclaw plugins ...` or `openclaw skills ...` command interactively.",
  "  • For reviewed direct CLI automation, add --acknowledge-install-policy-warning.",
  "  • If no equivalent direct command exists, change security.installPolicy to allow this reviewed request, then retry.",
  "  • --force does not approve install policy warnings.",
];
const notice = (name, out) => {
  const text = (value) => String(value).replace(/\p{Cc}/gu, (c) => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c] ?? "");
  const line = (f) => `    • [${f.severity.toUpperCase()}] ${text(f.ruleId)}: ${text(f.message)}${f.file ? ` (${text(f.file)}${f.line ? `:${f.line}` : ""})` : ""}`;
  const findings = out.findings.length ? ["  Findings:", ...out.findings.map(line)] : [];
  return ["Install requires approval", "", `  Skill: ${text(name)}`, `  Reason: ${text(out.reason)}`, ...findings, "", ...GUIDANCE].join("\n");
};

test("a long review stays within OpenClaw's limits, most severe findings first", async () => {
  const dir = release({ "SKILL.md": "a" });
  const many = [...Array.from({ length: 150 }, () => finding("info", "outbound-host")), finding("critical")];
  const out = await decide(request(dir), review(dir, many));
  assert.equal(out.decision, "warn");
  assert.ok(out.findings.length <= 100);
  assert.equal(out.findings[0].severity, "critical");
  assert.match(out.reason, new RegExp(`Showing ${out.findings.length} of 151 findings`));
  assert.ok(notice("tool", out).length <= 4_000);

  const wordy = Array.from({ length: 12 }, () => ({ ...finding("warn"), message: "line\n".repeat(150) }));
  const long = await decide(request(dir), review(dir, wordy));
  assert.ok(long.findings.length < 12);
  assert.ok(notice("tool", long).length <= 4_000);
});

test("a review that fits keeps every finding and its reason", async () => {
  const dir = release({ "SKILL.md": "a" });
  const out = await decide(request(dir), review(dir, Array.from({ length: 14 }, () => ({ ...finding("warn"), message: "m".repeat(150) }))));
  assert.equal(out.findings.length, 14);
  assert.doesNotMatch(out.reason, /Showing/);
});
