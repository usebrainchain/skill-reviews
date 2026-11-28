#!/usr/bin/env node
// Finds reviews that publishers ordered of their own releases on the BrainChain task board, and adds each accepted one
// to this index, marked as ordered by the publisher.
//   node scripts/ordered.mjs <testnet|mainnet> [--dry]
// A task counts when its title names a ClawHub skill or MCP server release and its brief is the publisher template for
// exactly that release (scripts/publisher-task.mjs), rebuilt here from the release as the registry serves it. Before a
// review is added: the downloaded release matches the artifact the brief names, the task was accepted and checks out
// against the chain, every cited line holds against the files, and the receipt shows who paid. Whether the payer is
// the publisher is checked only when the release names the paying address; the review says which.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deskOf } from "./accepted.mjs";
import { mcpTask, PUBLISHER_SECTION, readRelease, releaseOf, skillTask } from "./briefs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const RPC = { mainnet: "https://rpc.usebrainchain.com", testnet: "https://rpc.testnet.usebrainchain.com" };
// keccak256("Posted(uint256,address,uint128,uint64,bytes32,string)"), TaskBoard's event for a new task.
const POSTED = "0x7c1c491e8c1a7f70f8859b23eac675ac153697f160a98688e35aecdea187174f";
const SPAN = 50_000;
const DATA_URI = "data:application/json;base64,";

const get = async (url, as = "json") => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Object.assign(new Error(`${url} answered ${response.status}`), { status: response.status });
  return as === "json" ? response.json() : Buffer.from(await response.arrayBuffer());
};

async function rpc(network, method, params) {
  const response = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** A Posted log as { id, poster, task }: the task is the JSON its data URI carries, or undefined for any other URI. */
export function decodePosted(log) {
  const data = Buffer.from(log.data.slice(2), "hex");
  const offset = Number(data.readBigUInt64BE(96 + 24));
  const length = Number(data.readBigUInt64BE(offset + 24));
  const uri = data.subarray(offset + 32, offset + 32 + length).toString("utf8");
  let task;
  if (uri.startsWith(DATA_URI)) {
    try {
      task = JSON.parse(Buffer.from(uri.slice(DATA_URI.length), "base64").toString("utf8"));
    } catch {}
  }
  return { id: Number(BigInt(log.topics[1])), poster: `0x${log.topics[2].slice(26)}`, task };
}

/** The release a publisher-ordered task names, with the index file its review goes to; undefined for other tasks. */
export function orderedRelease(task) {
  if (!task || typeof task.brief !== "string" || !task.brief.includes(PUBLISHER_SECTION) || !/^0x[0-9a-f]{64}$/.test(task.order ?? "")) return undefined;
  const release = releaseOf(task.title);
  if (release?.kind === "skill") return { ...release, path: join("reviews", release.owner, release.slug, `${release.version}.json`) };
  if (release?.kind === "mcp") {
    const line = /^(\S+) (\S+) on (npm|PyPI), artifact (\S+)\. Files:/m.exec(task.brief);
    if (!line || line[1] !== release.name || line[2] !== release.version) return undefined;
    const registry = line[3] === "npm" ? "npm" : "pypi";
    return { ...release, registry, artifact: line[4], path: join("mcp", registry, ...release.name.split("/"), `${release.version}.json`) };
  }
  return undefined;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const noLinks = (dir) => {
  if (sh("find", [dir, "-type", "l"])) throw new Error("the release contains a symbolic link");
};
// An archive's contents, under its one top-level directory when it has exactly one (npm's package/, an sdist's).
const topOf = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? join(dir, entries[0].name) : dir;
};

/** Downloads the release into a new directory and returns where its files are, checked against what the brief names. */
export async function download(release, into) {
  const archive = join(into, "archive");
  const unpacked = join(into, "release");
  mkdirSync(unpacked);
  if (release.kind === "skill") {
    const query = new URLSearchParams({ slug: release.slug, ownerHandle: release.owner, version: release.version });
    writeFileSync(archive, await get(`https://clawhub.ai/api/v1/download?${query}`, "bytes"));
    sh("unzip", ["-q", archive, "-d", unpacked]);
    noLinks(unpacked);
    return unpacked;
  }
  if (release.registry === "npm") {
    const meta = await get(`https://registry.npmjs.org/${release.name.replace("/", "%2F")}/${encodeURIComponent(release.version)}`);
    if (meta.dist?.integrity !== release.artifact) throw new Error(`npm's integrity for ${release.name}@${release.version} is ${meta.dist?.integrity}, not the ${release.artifact} the brief names`);
    const bytes = await get(meta.dist.tarball, "bytes");
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== release.artifact) throw new Error("the tarball does not match its integrity");
    writeFileSync(archive, bytes);
    sh("tar", ["-xzf", archive, "-C", unpacked]);
    noLinks(unpacked);
    return topOf(unpacked);
  }
  const meta = await get(`https://pypi.org/pypi/${encodeURIComponent(release.name)}/${encodeURIComponent(release.version)}/json`);
  const file = (meta.urls ?? []).find((u) => u.digests?.sha256 === release.artifact);
  if (!file) throw new Error(`PyPI has no file of ${release.name} ${release.version} with sha256 ${release.artifact}`);
  const bytes = await get(file.url, "bytes");
  if (createHash("sha256").update(bytes).digest("hex") !== release.artifact) throw new Error("the PyPI file does not match its sha256");
  writeFileSync(archive, bytes);
  if (/\.(whl|zip)$/.test(file.filename)) sh("unzip", ["-q", archive, "-d", unpacked]);
  else if (/\.tar\.gz$/.test(file.filename)) sh("tar", ["-xzf", archive, "-C", unpacked]);
  else throw new Error(`cannot unpack ${file.filename}`);
  noLinks(unpacked);
  return topOf(unpacked);
}

/** Why a posted task is not the publisher template for the release, or undefined when it is exactly that. */
export function templateMismatch(release, dir, posted) {
  const built =
    release.kind === "skill"
      ? skillTask(readRelease(dir, { skip: ["_meta.json"] }), release.owner, release.slug, release.version).task
      : mcpTask(readRelease(dir), release.registry, release.name, release.version, release.artifact).task;
  if (posted.title !== built.title) return "its title is not the template's";
  if (posted.brief !== built.brief) return "its brief is not the template for these files";
  if (JSON.stringify(posted.levels) !== JSON.stringify(built.levels)) return "its levels are not the template's";
  if (posted.passIndex !== undefined && posted.passIndex !== 1) return "it pays at a level other than the template's";
  return undefined;
}

async function main() {
  const [network] = process.argv.slice(2);
  const dry = process.argv.includes("--dry");
  if (!RPC[network]) {
    console.error("usage: ordered.mjs <testnet|mainnet> [--dry]");
    process.exit(1);
  }
  const desk = deskOf(network);
  const { manifest } = await get(`${desk}/network.json`);
  const board = manifest.activeSet.contracts.TaskBoard;
  const head = Number(await rpc(network, "eth_blockNumber", []));
  const posted = [];
  for (let from = manifest.activeSet.fromBlock; from <= head; from += SPAN) {
    const logs = await rpc(network, "eth_getLogs", [{ address: board, topics: [POSTED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${Math.min(head, from + SPAN - 1).toString(16)}` }]);
    for (const log of logs) posted.push(decodePosted(log));
  }
  const releases = new Map();
  for (const p of posted) {
    const release = orderedRelease(p.task);
    if (release) (releases.get(release.path) ?? releases.set(release.path, { release, tasks: [] }).get(release.path)).tasks.push(p);
  }
  console.log(`${network} board ${board}: ${posted.length} tasks, ${releases.size} ${releases.size === 1 ? "release" : "releases"} ordered by a publisher`);

  const added = [];
  for (const [path, { release, tasks }] of releases) {
    const name = release.kind === "skill" ? `${release.owner}/${release.slug} ${release.version}` : `${release.registry}:${release.name} ${release.version}`;
    if (existsSync(join(root, path))) {
      console.log(`${name}: already in the index`);
      continue;
    }
    tasks.sort((a, b) => a.id - b.id);
    let chosen;
    for (const t of tasks) {
      const status = await get(`${desk}/x402/tasks/${t.task.order}`).catch((error) => (error.status === 404 ? undefined : Promise.reject(error)));
      if (status?.task?.accepted === true && status.result && String(status.taskId) === String(t.id) && status.board?.toLowerCase() === board.toLowerCase()) {
        chosen = { ...t, status };
        break;
      }
    }
    if (!chosen) {
      console.log(`${name}: tasks ${tasks.map((t) => t.id).join(", ")}, none accepted yet`);
      continue;
    }
    const work = mkdtempSync(join(tmpdir(), "ordered-review-"));
    try {
      const dir = await download(release, work);
      const mismatch = templateMismatch(release, dir, chosen.task);
      if (mismatch) {
        console.log(`${name}: task ${chosen.id} is not added: ${mismatch}`);
        continue;
      }
      if (!chosen.status.receipt) {
        console.log(`${name}: task ${chosen.id} is accepted and is the template for the release; its receipt, which names the payer, comes once the board pays`);
        continue;
      }
      if (dry) {
        console.log(`${name}: task ${chosen.id} would be added to ${path}`);
        continue;
      }
      const ids = tasks.map((t) => t.id).join(",");
      const args =
        release.kind === "skill"
          ? ["add-review.mjs", dir, `${release.owner}/${release.slug}`, release.version, network, chosen.task.order]
          : ["add-mcp-review.mjs", dir, `${release.registry}:${release.name}`, release.version, network, chosen.task.order, release.artifact];
      console.log(execFileSync("node", [join(here, args[0]), ...args.slice(1), "--publisher-tasks", ids], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 1_800_000 }).trim());
      added.push(path);
    } catch (error) {
      console.log(`${name}: task ${chosen.id} is not added: ${error.message.split("\n")[0]}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  console.log(`added ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await main();
