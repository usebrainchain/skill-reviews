#!/usr/bin/env node
// Adds an accepted BrainChain review of an agent configuration to configs/<kind>/<name>/<version or date>.json.
//   node scripts/add-config-review.mjs <reviewed dir> <kind>:<name> <version or date> <testnet|mainnet> <order> [--source <url>]
// The reviewed dir holds the configuration's files exactly as the review read them, secrets already replaced with
// <redacted> (the review task writes them out). --source says where the configuration was published, when it was.
// Every cited line is checked against the files, and the files are checked for secrets that were left in.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseHash } from "../gate/brainchain-review-gate.mjs";
import { acceptedResult, citationProblems, pythonNames } from "./accepted.mjs";
import { readRelease } from "./briefs.mjs";

const KINDS = ["openclaw", "claude-code", "cursor", "hermes", "codex", "other"];
// Secret shapes the review task replaces; any left means the files are not the ones it reviewed, or it missed one.
const SECRETS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\b0x[0-9a-fA-F]{64}\b/,
];
// Public 32-byte constants with a key's shape, which the review task leaves in: the EIP-1967 implementation, admin and
// beacon slots and EIP-1822's proxiable slot.
const PUBLIC_HEX = new Set([
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
]);
const secretIn = (line) => {
  const rest = line.replace(/\b0x[0-9a-fA-F]{64}\b/g, (m) => (PUBLIC_HEX.has(m.toLowerCase()) ? "" : m));
  return SECRETS.some((re) => re.test(rest));
};

const argv = process.argv.slice(2);
const at = argv.indexOf("--source");
const source = at >= 0 ? argv.splice(at, 2)[1] : undefined;
const [dir, config, version, network, order] = argv;
const [kind, name] = /^([a-z-]+):([\w.@/-]+)$/.exec(config ?? "")?.slice(1) ?? [];
if (!dir || !KINDS.includes(kind) || !name || name.split("/").some((p) => !p || p.startsWith(".")) || !/^[\w.+-]+$/.test(version ?? "") || !["testnet", "mainnet"].includes(network) || !order || (at >= 0 && !/^https:\/\//.test(source ?? ""))) {
  console.error(`usage: add-config-review.mjs <reviewed dir> <${KINDS.join("|")}>:<name> <version or date> <testnet|mainnet> <order> [--source <https url>]`);
  process.exit(1);
}

const files = readRelease(dir);
const leaked = files.flatMap(({ path, text }) => text.split("\n").flatMap((line, i) => (secretIn(line) ? [`${path} line ${i + 1}`] : [])));
if (leaked.length) throw new Error(`these lines look like secrets, so the files are not published: ${leaked.join(", ")}`);

const accepted = await acceptedResult(network, order);
const parsed = pythonNames(accepted.code, ["summary", "entries", "permissions", "findings"]);
const problems = citationProblems(dir, [...parsed.entries.map((e) => [`entry ${e.name}`, e]), ...parsed.findings.map((f, i) => [`finding ${i}`, f])]);
if (problems.length) throw new Error(`the review's citations do not hold against the files:\n${problems.join("\n")}`);

const review = {
  config: { kind, name, version, ...(source ? { source } : {}) },
  files: releaseHash(dir),
  network,
  board: accepted.board,
  task: accepted.task,
  order,
  record: accepted.record,
  verify: accepted.verify,
  summary: parsed.summary,
  entries: parsed.entries.map(({ name, kind, file, line, reach, untrusted_input, approval, note }) => ({ name, kind, file, line, reach, untrustedInput: untrusted_input, approval, note })),
  permissions: parsed.permissions,
  findings: parsed.findings.map(({ ruleId, severity, file, line, message }) => ({ ruleId, severity, file, line, message })),
  reviewedAt: new Date().toISOString().slice(0, 10),
};
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "configs", kind, ...name.split("/"), `${version}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(review, null, 2)}\n`);
console.log(`${out}: ${review.entries.length} entries, ${review.findings.length} findings, files ${review.files}`);
