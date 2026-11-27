#!/usr/bin/env node
// The review task a publisher posts for its own release, and with --post, posts it through the BrainChain MCP.
//   node scripts/publisher-task.mjs <release dir> clawhub:<owner>/<slug> <version> [--post]
//   node scripts/publisher-task.mjs <release dir> npm:<package> <version> <dist.integrity> [--post]
//   node scripts/publisher-task.mjs <release dir> pypi:<package> <version> <file sha256> [--post]
// The release dir holds the files exactly as the registry serves them, unpacked (for npm, the tarball's package/
// directory). Without --post it prints the task as JSON: title, brief and levels, the arguments brainchain_post_task
// takes, to be passed unchanged. --post needs the paying wallet in BRAINCHAIN_PAYER_KEY_FILE or BRAINCHAIN_PAYER_KEY,
// and BRAINCHAIN_NETWORK (mainnet or testnet); the MCP's other settings, such as BRAINCHAIN_PAY_ON, apply as usual.
import { spawn } from "node:child_process";

import { MAX_BRIEF, mcpTask, readRelease, skillTask } from "./briefs.mjs";

const MCP = "brainchain-mcp@0.25.1";

/** The task for a release, or a reason it cannot be posted. */
export function publisherTask(dir, release, version, artifact) {
  const skill = /^clawhub:([\w.-]+)\/([\w.-]+)$/.exec(release ?? "");
  const mcp = /^(npm|pypi):((?:@[\w.-]+\/)?[\w.-]+)$/.exec(release ?? "");
  if (!skill && !mcp) throw new Error("name the release as clawhub:<owner>/<slug>, npm:<package> or pypi:<package>");
  if (!/^[\w.+-]+$/.test(version ?? "")) throw new Error("give the release's version");
  let built;
  if (skill) built = skillTask(readRelease(dir, { skip: ["_meta.json"] }), skill[1], skill[2], version);
  else {
    const ok = mcp[1] === "npm" ? /^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact ?? "") : /^[0-9a-f]{64}$/.test(artifact ?? "");
    if (!ok) throw new Error(mcp[1] === "npm" ? "give the tarball's dist.integrity (npm view <package>@<version> dist.integrity)" : "give the sha256 of the PyPI file you unpacked");
    built = mcpTask(readRelease(dir), mcp[1], mcp[2], version, artifact);
  }
  if (built.task.brief.length > MAX_BRIEF) throw new Error(`the brief is ${built.task.brief.length} characters, over the ${MAX_BRIEF} a task takes`);
  return built;
}

/** Calls one tool on the BrainChain MCP over stdio, the way an agent's client does. */
export async function callMcp(tool, args, env = process.env) {
  const child = spawn("npx", ["-y", MCP], { env, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  const exited = new Promise((_, reject) => child.once("exit", (code) => reject(new Error(`${MCP} exited with ${code}`))));
  let id = 0;
  const request = (method, params) =>
    Promise.race([
      new Promise((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
      exited,
    ]);
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "skill-reviews", version: "1" } });
    if (init.error) throw new Error(init.error.message);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const reply = await request("tools/call", { name: tool, arguments: args });
    if (reply.error) throw new Error(reply.error.message);
    return JSON.parse(reply.result.content.map((c) => c.text).join("\n"));
  } finally {
    child.kill();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2).filter((a) => a !== "--post");
  const [dir, release, version, artifact] = args;
  let built;
  try {
    built = publisherTask(dir, release, version, artifact);
  } catch (error) {
    console.error(`${error.message}\nusage: publisher-task.mjs <release dir> <clawhub:owner/slug | npm:package | pypi:package> <version> [artifact] [--post]`);
    process.exit(1);
  }
  if (!process.argv.includes("--post")) {
    console.log(JSON.stringify(built.task));
  } else {
    if (!(process.env.BRAINCHAIN_PAYER_KEY_FILE || process.env.BRAINCHAIN_PAYER_KEY) || !["mainnet", "testnet"].includes(process.env.BRAINCHAIN_NETWORK ?? "")) {
      console.error("--post needs BRAINCHAIN_PAYER_KEY_FILE (or BRAINCHAIN_PAYER_KEY) and BRAINCHAIN_NETWORK=mainnet or testnet");
      process.exit(1);
    }
    const posted = await callMcp("brainchain_post_task", built.task);
    console.log(JSON.stringify(posted, null, 2));
    if (!posted.order) process.exit(1);
  }
}
