import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { untrusted } from "./brainchain-install-check.mjs";

const BIN = fileURLToPath(new URL("./brainchain-install-check.mjs", import.meta.url));

// A stand-in for the openclaw CLI: the config commands the installer uses, over a plain JSON file, with each call logged.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const write = (config) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(config)); };
const [, , group, verb, key, value] = process.argv;
fs.appendFileSync(path.join(process.env.HOME, "calls.log"), process.argv.slice(2).join(" ") + "\\n");
if (verb === "file") { console.log(JSON.stringify({ path: file })); process.exit(0); }
const policy = read().security?.installPolicy;
if (verb === "get") {
  if (!policy) { console.log(JSON.stringify({ ok: false, error: { message: "Config path is valid but unset: " + key } })); process.exit(1); }
  console.log(JSON.stringify(policy)); process.exit(0);
}
if (verb === "set") {
  if (process.env.FAKE_SET_FAILS) { console.error("Config is read-only."); process.exit(1); }
  const config = read(); config.security = { ...config.security, installPolicy: JSON.parse(value) }; write(config); process.exit(0);
}
if (verb === "unset") { const config = read(); delete config.security.installPolicy; write(config); process.exit(0); }
process.exit(2);
`;

function setup() {
  const home = mkdtempSync(join(tmpdir(), "install-check-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "openclaw"), FAKE, { mode: 0o755 });
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const run = (args = [], extra = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...env, ...extra } });
  const config = () => JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
  const calls = () => readFileSync(join(home, "calls.log"), "utf8");
  return { home, run, config, calls, gate: join(home, ".openclaw", "policy", "brainchain-review-gate.mjs") };
}

test("install: copies the policy where only you can write and turns it on for skills", () => {
  const { run, config, gate } = setup();
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /install check is on/);
  assert.equal(statSync(gate).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(gate)).mode & 0o777, 0o700);
  assert.deepEqual(config().security.installPolicy, {
    enabled: true,
    targets: ["skill"],
    exec: { source: "exec", command: gate, timeoutMs: 10000, passEnv: ["HOME", "PATH"] },
  });
});

test("install again: updates the policy and leaves the setting alone", () => {
  const { run, calls } = setup();
  run();
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /up to date/);
  assert.equal(calls().match(/config set/g).length, 1);
});

test("another policy is on: nothing changes without --replace", () => {
  const { home, run, config, gate } = setup();
  mkdirSync(join(home, ".openclaw"));
  const theirs = { enabled: true, exec: { source: "exec", command: "/usr/local/bin/their-policy" } };
  writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ security: { installPolicy: theirs } }));
  const out = run();
  assert.equal(out.status, 1);
  assert.match(out.stderr, /another install policy \(\/usr\/local\/bin\/their-policy\).*--replace/s);
  assert.deepEqual(config().security.installPolicy, theirs);
  assert.equal(existsSync(gate), false);
  assert.equal(run(["--replace"]).status, 0);
  assert.equal(config().security.installPolicy.exec.command, gate);
});

test("OpenClaw refuses the setting: says so and prints it to add by hand", () => {
  const { run } = setup();
  const out = run([], { FAKE_SET_FAILS: "1" });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /read-only[\s\S]*"installPolicy"/);
});

test("remove: turns the policy off and deletes it", () => {
  const { run, config, gate } = setup();
  run();
  const out = run(["remove"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(config().security.installPolicy, undefined);
  assert.equal(existsSync(dirname(gate)), false);
});

test("remove leaves another policy as it is", () => {
  const { home, run, config } = setup();
  mkdirSync(join(home, ".openclaw"));
  const theirs = { enabled: true, exec: { source: "exec", command: "/usr/local/bin/their-policy" } };
  writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify({ security: { installPolicy: theirs } }));
  const out = run(["remove"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /left as it is/);
  assert.deepEqual(config().security.installPolicy, theirs);
});

test("no OpenClaw on the PATH", () => {
  const { home } = setup();
  const out = spawnSync(process.execPath, [BIN], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /OpenClaw is not on your PATH/);
});

test("untrusted: a folder others can write, unless it is sticky", () => {
  const dir = mkdtempSync(join(tmpdir(), "install-check-perm-"));
  const open = join(dir, "open");
  mkdirSync(open);
  writeFileSync(join(open, "gate.mjs"), "", { mode: 0o700 });
  chmodSync(open, 0o777);
  assert.match(untrusted(join(open, "gate.mjs")), /open can be written by other users/);
  chmodSync(open, 0o1777);
  assert.equal(untrusted(join(open, "gate.mjs")), undefined);
  chmodSync(join(open, "gate.mjs"), 0o720);
  assert.match(untrusted(join(open, "gate.mjs")), /gate\.mjs can be written by other users/);
});
