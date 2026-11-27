#!/usr/bin/env node
// Turns on BrainChain's install check in OpenClaw: copies the policy into OpenClaw's config directory, in a folder
// only you can write, and points security.installPolicy at it. `remove` turns it off again.
//
// OpenClaw blocks every covered install while a policy is enabled but cannot run, so nothing is enabled until the
// copied policy has passed OpenClaw's own path rules and answered a test request.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SELF = `npx -y ${PACKAGE.name}@${PACKAGE.version}`;
const GATE = "brainchain-review-gate.mjs";
const SOURCE = fileURLToPath(new URL(`../gate/${GATE}`, import.meta.url));
const DOCS = "https://docs.usebrainchain.com/install-check";
const KEY = "security.installPolicy";

class Stop extends Error {}

const HELP = `Check skills against BrainChain's reviews before OpenClaw installs them.

Usage:
  ${SELF}            turn the check on, or update it
  ${SELF} remove     turn it off

Options:
  --replace   use BrainChain's check in place of another install policy

Docs: ${DOCS}
`;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Stop("OpenClaw is not on your PATH. Install OpenClaw (https://docs.openclaw.ai/install), then run this again.");
  }
  if (result.error) throw result.error;
  return result;
}

// The last JSON object in a command's output; some OpenClaw builds print a line or two before it.
function lastJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

const said = (result) => (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join("\n");

function configFile() {
  const result = run("openclaw", ["config", "file", "--json"]);
  const path = lastJson(result.stdout)?.path ?? result.stdout.trim().split("\n").pop();
  if (result.status !== 0 || !path || !isAbsolute(path)) throw new Stop(`OpenClaw did not say where its config is:\n${said(result)}`);
  return path;
}

/** The configured install policy, or undefined when none is set. */
function currentPolicy() {
  const result = run("openclaw", ["config", "get", KEY, "--json"]);
  const value = result.status === 0 ? lastJson(result.stdout) : undefined;
  if (value) return value;
  if (result.status !== 0 && /unset|not set|not found/i.test(result.stdout + result.stderr)) return undefined;
  throw new Stop(`Could not read ${KEY} from OpenClaw:\n${said(result)}`);
}

/**
 * Why OpenClaw would refuse to run `path` as a policy, or undefined. Its rules: the file is not a symbolic link, no one
 * else can write it, and it belongs to you or root; every directory above it belongs to you or root, and no one else
 * can write it unless it is sticky, as /tmp is.
 */
export function untrusted(path, uid = process.getuid()) {
  const file = lstatSync(path);
  if (file.isSymbolicLink()) return `${path} is a symbolic link`;
  if (file.mode & 0o022) return `${path} can be written by other users`;
  if (file.uid !== uid && file.uid !== 0) return `${path} belongs to another user`;
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const info = statSync(dir);
    if (info.mode & 0o022 && !(info.mode & 0o1000)) return `${dir} can be written by other users`;
    if (info.uid !== uid && info.uid !== 0) return `${dir} belongs to another user`;
    if (dir === dirname(dir)) return undefined;
  }
}

// Writes the policy next to its final name and renames it into place, so OpenClaw never runs half a file.
function writeGate(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Stop(`${dir} is a symbolic link; OpenClaw needs the policy in a real folder.`);
  chmodSync(dir, 0o700);
  const target = join(dir, GATE);
  const temporary = join(dir, `.${GATE}.${process.pid}`);
  copyFileSync(SOURCE, temporary);
  chmodSync(temporary, 0o700);
  renameSync(temporary, target);
  return target;
}

// Runs the policy as OpenClaw does, directly and with only HOME and PATH, on a request that needs no network.
function selfTest(gate) {
  const request = { protocolVersion: 1, targetType: "skill", targetName: "self-test", origin: { type: "path" } };
  const result = spawnSync(gate, [], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
    timeout: 10_000,
  });
  const answer = result.status === 0 ? lastJson(result.stdout) : undefined;
  if (answer?.protocolVersion === 1 && answer.decision === "warn") return;
  const why = result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
  throw new Stop(`The check did not run (${why}). It needs Node.js 22 or later on your PATH.`);
}

function install({ replace }) {
  const config = configFile();
  const gatePath = join(dirname(config), "policy", GATE);
  const existing = currentPolicy();
  const ours = existing?.exec?.command === gatePath;
  if (existing?.enabled && existing.exec?.command && !ours && !replace) {
    throw new Stop(
      `OpenClaw already runs another install policy (${existing.exec.command}). OpenClaw runs one policy at a time, so nothing was changed. To use BrainChain's check in its place, run:\n  ${SELF} --replace`,
    );
  }
  const gate = writeGate(dirname(gatePath));
  const problem = untrusted(gate);
  if (problem) {
    throw new Stop(`OpenClaw will not run a policy from here: ${problem}. Fix that (for a folder, chmod go-w <folder>), then run this again.`);
  }
  selfTest(gate);

  if (ours && existing.enabled) return report("updated", gate, config);
  const policy = {
    enabled: true,
    targets: ["skill"],
    exec: { source: "exec", command: gate, timeoutMs: 10_000, passEnv: ["HOME", "PATH"] },
  };
  const result = run("openclaw", ["config", "set", KEY, JSON.stringify(policy), "--strict-json"]);
  if (result.status !== 0) {
    throw new Stop(
      `OpenClaw did not save the setting:\n${said(result)}\n\nThe check is saved at ${gate}. To turn it on yourself, add this to ${config}:\n\n${snippet(policy)}`,
    );
  }
  report("on", gate, config);
}

const snippet = (policy) => JSON.stringify({ security: { installPolicy: policy } }, null, 2);

const OUTCOMES = [
  ["Reviewed, informational findings only", "installs"],
  ["Reviewed, with warnings", "shows the findings and asks you to approve"],
  ["Reviewed, runs code it downloads or decodes", "blocked"],
  ["Not reviewed, or the files differ", "asks you to approve, and says why"],
];

function report(state, gate, config) {
  const table = OUTCOMES.map(([found, outcome]) => `  ${found.padEnd(46)}${outcome}`).join("\n");
  console.log(`BrainChain's install check is ${state === "updated" ? "up to date" : "on"}.

Before OpenClaw installs a skill from ClawHub, it checks the release against BrainChain's reviews:

${table}

To install after reading the findings, run the same openclaw skills install command in a terminal and type the
skill's name when asked, or add --acknowledge-install-policy-warning.

Policy: ${gate}
Config: ${KEY} in ${config}

Run this command again to update the check. To turn it off: ${SELF} remove`);
}

function remove() {
  const config = configFile();
  const gatePath = join(dirname(config), "policy", GATE);
  const existing = currentPolicy();
  if (existing?.exec?.command === gatePath) {
    const result = run("openclaw", ["config", "unset", KEY]);
    if (result.status !== 0) throw new Stop(`OpenClaw did not remove the setting:\n${said(result)}\n\nRemove ${KEY} from ${config} yourself.`);
  } else if (existing) {
    console.log(`OpenClaw runs another install policy (${existing.exec?.command ?? "no command"}); it was left as it is.`);
  }
  if (existsSync(gatePath)) rmSync(gatePath);
  const dir = dirname(gatePath);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  console.log("BrainChain's install check is off. OpenClaw installs skills without it.");
}

// npx runs the bin through a link in node_modules/.bin; Node resolves links in this module's URL but not in argv[1].
const invokedAs = () => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]);
  } catch {
    return undefined;
  }
};

if (fileURLToPath(import.meta.url) === invokedAs()) {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-")) ?? "install";
  try {
    if (args.includes("--help") || args.includes("-h") || command === "help") console.log(HELP);
    else if (args.includes("--version")) console.log(PACKAGE.version);
    else if (process.platform === "win32") throw new Stop("The install check runs on macOS and Linux.");
    else if (command === "install") install({ replace: args.includes("--replace") });
    else if (command === "remove") remove();
    else throw new Stop(`Unknown command: ${command}\n\n${HELP}`);
  } catch (error) {
    console.error(error instanceof Stop ? error.message : error);
    process.exitCode = 1;
  }
}
