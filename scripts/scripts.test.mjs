import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { citationProblems, payerNamedIn } from "./accepted.mjs";
import { lineKey, mcpTask, PUBLISHER_SECTION, releaseOf } from "./briefs.mjs";
import { decodePosted, orderedRelease, templateMismatch } from "./ordered.mjs";
import { publisherTask } from "./publisher-task.mjs";

const PAYER = "0x46e92cF98d3430b39d5de7c15695894590BBfBBe";

function release(files) {
  const dir = mkdtempSync(join(tmpdir(), "skill-reviews-test-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const skill = {
  "_meta.json": '{"slug":"pay"}',
  "SKILL.md": `---\nname: pay\nmetadata: {"openclaw": {"requires": {"env": ["PAY_TOKEN"]}}}\n---\n\nSet PAY_TOKEN and WALLET_KEY=0x... before you run it.\n\n<!-- brainchain-review-payer: ${PAYER} -->\n`,
  "scripts/pay.sh": 'curl -s https://pay.example.com/v1 -H "Authorization: $PAY_TOKEN"\n',
  ".hidden/notes.txt": "kept in the brief like any other file\n",
};

test("a line is cited by its first 24 letters and digits", () => {
  assert.equal(lineKey("  const pool = new pg.Pool({"), lineKey("const pool = new pg.Pool"));
  assert.notEqual(lineKey("const pool = new pg.Pool({"), lineKey("const client = await pool.connect();"));
  assert.equal(lineKey("  });"), "----");
  assert.equal(lineKey('        "nx",'), lineKey("nx"));
  assert.notEqual(lineKey('"nx",'), lineKey('"mcp"'));
  assert.notEqual(lineKey('"nx",'), "----");
});

test("citations are checked against the release files", () => {
  const dir = release(skill);
  try {
    const ok = { file: "scripts/pay.sh", line: 1, code: 'curl -s https://pay.example.com/v1 -H "Auth' };
    assert.deepEqual(citationProblems(dir, [["finding 0", ok], ["finding 1", { file: "SKILL.md", line: 6 }]]), []);
    assert.deepEqual(
      citationProblems(dir, [
        ["finding 0", { ...ok, line: 2 }],
        ["finding 1", { file: "SKILL.md", line: 99 }],
        ["finding 2", { file: "../etc/passwd", line: 1 }],
        ["finding 3", { file: "SKILL.md", line: 6, code: "Something else entirely here" }],
      ]),
      [
        "finding 0: its code is not the start of scripts/pay.sh line 2",
        "finding 1: line 99 is outside SKILL.md",
        "finding 2: ../etc/passwd is not a file in the release",
        "finding 3: its code is not the start of SKILL.md line 6",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a release names its payer on a brainchain-review-payer line", () => {
  const files = [
    { path: "README.md", text: "# x\n\nbrainchain-review-payer: 0x0000000000000000000000000000000000000001\n" },
    { path: "package.json", text: `{\n  "name": "x",\n  "brainchain-review-payer": "${PAYER.toLowerCase()}"\n}\n` },
  ];
  assert.equal(payerNamedIn(files, PAYER), "package.json line 3");
  assert.equal(payerNamedIn(files, "0x0000000000000000000000000000000000000002"), undefined);
});

test("the publisher template is built from the files alone, hidden ones included, and checks every citation", () => {
  const dir = release(skill);
  try {
    const { task, scan } = publisherTask(dir, "clawhub:acme/pay", "1.2.0");
    assert.equal(task.title, "Review ClawHub skill acme/pay 1.2.0");
    assert.ok(task.brief.includes(PUBLISHER_SECTION));
    assert.ok(task.brief.includes('<file path=".hidden/notes.txt">'));
    assert.ok(!task.brief.includes("_meta.json"));
    assert.ok(task.brief.includes("_cited(f, f\"finding {i}\")"));
    assert.deepEqual(scan.must, ["undeclared-env", "wallet-key"]);
    assert.equal(task.brief, task.brief.trimEnd(), "built as the desk posts it");
    assert.deepEqual(publisherTask(dir, "clawhub:acme/pay", "1.2.0").task, task, "the same files give the same task");
    assert.throws(() => publisherTask(dir, "npm:pay", "1.2.0", "sha512-short"), /dist\.integrity/);
    assert.throws(() => publisherTask(dir, "github:acme/pay", "1.2.0"), /clawhub:<owner>\/<slug>/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// A Posted log as the board emits it: bounty, deadline, briefHash, then the brief's data URI.
function postedLog(id, poster, task) {
  const uri = Buffer.from(`data:application/json;base64,${Buffer.from(JSON.stringify(task)).toString("base64")}`);
  const word = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex");
  const padded = Buffer.concat([uri, Buffer.alloc((32 - (uri.length % 32)) % 32)]);
  const data = Buffer.concat([word(1_000_000), word(1_800_000_000), Buffer.alloc(32, 7), word(128), word(uri.length), padded]);
  return { topics: ["0x7c1c491e8c1a7f70f8859b23eac675ac153697f160a98688e35aecdea187174f", `0x${word(id).toString("hex")}`, `0x${"0".repeat(24)}${poster.slice(2)}`], data: `0x${data.toString("hex")}` };
}

test("the feed reads publisher-ordered tasks off the board and holds each to the template for its release", () => {
  const dir = release(skill);
  try {
    const { task } = publisherTask(dir, "clawhub:acme/pay", "1.2.0");
    const posted = { ...task, order: `0x${"ab".repeat(32)}`, passIndex: 1 };
    const decoded = decodePosted(postedLog(412, "0xf848984c8a0d9e49cc9c97380c62b34c6f3b97d1", posted));
    assert.equal(decoded.id, 412);
    assert.equal(decoded.poster, "0xf848984c8a0d9e49cc9c97380c62b34c6f3b97d1");
    assert.deepEqual(decoded.task, posted);
    const found = orderedRelease(decoded.task);
    assert.deepEqual(found, { kind: "skill", owner: "acme", slug: "pay", version: "1.2.0", path: "reviews/acme/pay/1.2.0.json" });
    assert.equal(templateMismatch(found, dir, decoded.task), undefined);
    assert.equal(templateMismatch(found, dir, { ...posted, brief: posted.brief.replace("whether or not it suits", "if it suits") }), "its brief is not the template for these files");
    assert.equal(templateMismatch(found, dir, { ...posted, levels: ["Good", "Fine", "Bad"] }), "its levels are not the template's");
    writeFileSync(join(dir, "scripts/pay.sh"), "echo changed\n");
    assert.equal(templateMismatch(found, dir, posted), "its brief is not the template for these files");
    // The house feed's own tasks carry no publisher section, and other tasks name no release.
    assert.equal(orderedRelease({ ...posted, brief: posted.brief.replace(PUBLISHER_SECTION, "") }), undefined);
    assert.equal(orderedRelease({ title: "Summarise a paper", brief: PUBLISHER_SECTION, order: posted.order }), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("an MCP server task names its registry and artifact, and prose gives way when the files run long", () => {
  const files = [
    { path: "README.md", text: "x".repeat(40_000) },
    { path: "dist/index.js", text: 'server.tool("query", async () => fetch("https://db.example.com"));\n' },
    { path: "package.json", text: '{"name": "@acme/db-mcp"}\n' },
  ];
  const integrity = `sha512-${"A".repeat(86)}==`;
  const { task, left, scan } = mcpTask(files, "npm", "@acme/db-mcp", "0.1.0", integrity);
  assert.deepEqual(left, ["README.md"]);
  assert.deepEqual(scan.tools, ["query"]);
  assert.deepEqual(Object.keys(scan.must), ["network-access"]);
  assert.deepEqual(releaseOf(task.title), { kind: "mcp", name: "@acme/db-mcp", version: "0.1.0" });
  const found = orderedRelease({ ...task, order: `0x${"cd".repeat(32)}` });
  assert.deepEqual(found, { kind: "mcp", name: "@acme/db-mcp", version: "0.1.0", registry: "npm", artifact: integrity, path: "mcp/npm/@acme/db-mcp/0.1.0.json" });
});

test("a configuration with a secret left in is refused before anything is read from the desk", () => {
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const dir = release({
    "CLAUDE.md": `- \`cast storage <addr> ${slot}\` reads the EIP-1967 implementation slot.\n`,
    "openclaw.json": `{\n  env: { vars: { OPENAI_API_KEY: "s${"k-"}${"x".repeat(24)}" } },\n}\n`,
  });
  try {
    const script = join(dirname(fileURLToPath(import.meta.url)), "add-config-review.mjs");
    const run = spawnSync("node", [script, dir, "openclaw:acme/agent", "2026-11-28", "testnet", `0x${"ab".repeat(32)}`], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /these lines look like secrets, so the files are not published: openclaw\.json line 2$/m);
    const usage = spawnSync("node", [script, dir, "slack:acme/agent", "2026-11-28", "testnet", "0x1"], { encoding: "utf8" });
    assert.match(usage.stderr, /usage: add-config-review\.mjs/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
