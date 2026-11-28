// What add-review.mjs and add-mcp-review.mjs share: read an accepted review from the desk, confirm it against the
// chain, and read the names its Python block defines without running anything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lineKey } from "./briefs.mjs";

const get = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) });
export const deskOf = (network) => (network === "mainnet" ? "https://brain.usebrainchain.com" : "https://brain.testnet.usebrainchain.com");

/** The accepted result of a desk order, checked with the verify command the review will carry. */
export async function acceptedResult(network, order) {
  const desk = deskOf(network);
  // An accepted result is released a little after the grade, so read until its text is there (up to 15 minutes).
  let status, code;
  for (let attempt = 0; attempt < 30 && !code; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 30_000));
    const response = await get(`${desk}/x402/tasks/${order}`);
    if (!response.ok) throw new Error(`the desk answered ${response.status} for order ${order}`);
    status = await response.json().catch(() => {
      throw new Error(`the desk's answer for order ${order} is not JSON`);
    });
    // A task graded or settled without acceptance stays that way: there is nothing to wait for.
    if (status?.task?.accepted === false) throw new Error(`order ${order} was not accepted (task ${status.taskId} ${status.task.status})`);
    if (!status?.task?.accepted || !status.result) continue;
    const result = await get(status.result);
    if (result.ok) code = /```python\r?\n([\s\S]*?)```/.exec(await result.text())?.[1];
  }
  if (!status?.task?.accepted || !status.result) throw new Error(`order ${order} has no accepted result`);
  if (!code) throw new Error("the result has no Python block after 15 minutes");
  if (!/^\d+$/.test(status.taskId ?? "")) throw new Error(`the desk gave no task id for order ${order}`);
  // Task ids start again with each contract set, so the verify command names the board the task is on.
  if (!/^0x[0-9a-fA-F]{40}$/.test(status.board ?? "")) throw new Error(`the desk did not say which board order ${order} is on`);
  const board = status.board.toLowerCase();

  // Publish only what the chain confirms: run the verify command the review will carry, and require a match.
  const verify = ["brainchain-verify", network, "--task", String(status.taskId), "--set", board];
  let checked;
  try {
    checked = execFileSync("npx", ["--yes", ...verify], { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    throw new Error(`npx ${verify.join(" ")} found a mismatch or could not run:\n${error.stdout ?? error.message}`);
  }
  if (!/^Verdict: match\b/m.test(checked)) throw new Error(`npx ${verify.join(" ")} did not print a match:\n${checked}`);
  return { task: Number(status.taskId), board, record: status.result, verify: `npx ${verify.join(" ")}`, code, status };
}

/**
 * Who paid for an order, from the receipt BrainChain signs once the board pays or refunds the task. The verify command
 * checks the receipt's signature against the chain and the payment it names on the chain the payer paid on.
 */
export function verifiedPayer(network, status) {
  const payload = status?.receipt?.payload;
  if (!payload || !/^0x[0-9a-fA-F]{40}$/.test(payload.payer ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(payload.decisionLog ?? "") || !/^\d+$/.test(payload.decision ?? "")) {
    throw new Error(`order ${status?.order} has no receipt naming its payer yet`);
  }
  if (payload.job !== "task" || payload.outcome !== "accepted") throw new Error(`order ${status.order}'s receipt is for a ${payload.job} ${payload.outcome}, not an accepted task`);
  const receipt = `${deskOf(network)}/receipts/${payload.decisionLog.toLowerCase()}/${payload.decision}.json`;
  const verify = ["brainchain-verify", network, "--receipt", receipt];
  let checked;
  try {
    checked = execFileSync("npx", ["--yes", ...verify], { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    throw new Error(`npx ${verify.join(" ")} found a mismatch or could not run:\n${error.stdout ?? error.message}`);
  }
  if (!/^Verdict: match\b/m.test(checked)) throw new Error(`npx ${verify.join(" ")} did not print a match:\n${checked}`);
  return { payer: payload.payer, payment: { network: payload.network, transaction: payload.transaction }, receipt };
}

/**
 * Every cited line holds up against the files: the file is in the release, the line is in it, and where the citation
 * carries the line's start (`code`), its key is that line's key. Returns the problems; an empty list means all hold.
 */
export function citationProblems(dir, items) {
  const lines = new Map();
  const linesOf = (file) => {
    if (!lines.has(file)) {
      let text;
      try {
        text = typeof file === "string" && !file.split("/").includes("..") ? readFileSync(join(dir, file), "utf8") : undefined;
      } catch {}
      lines.set(file, text?.split("\n"));
    }
    return lines.get(file);
  };
  const problems = [];
  for (const [what, item] of items) {
    const text = linesOf(item.file);
    if (!text) problems.push(`${what}: ${item.file} is not a file in the release`);
    else if (!Number.isInteger(item.line) || item.line < 1 || item.line > text.length) problems.push(`${what}: line ${item.line} is outside ${item.file}`);
    else if ("code" in item && lineKey(item.code) !== lineKey(text[item.line - 1])) problems.push(`${what}: its code is not the start of ${item.file} line ${item.line}`);
  }
  return problems;
}

// A publisher shows the order is its own by naming the paying address in the release it publishes, on a line such as
// "brainchain-review-payer: 0x..." in any file (a README line, a comment, a package.json field).
const PAYER_LINE = /brainchain-review-payer["']?\s*[:=]\s*["']?(0x[0-9a-fA-F]{40})\b/gi;

/** Where the release names this payer, as "file line n"; undefined when it does not. */
export function payerNamedIn(files, payer) {
  for (const { path, text } of files) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(PAYER_LINE)) if (m[1].toLowerCase() === payer.toLowerCase()) return `${path} line ${i + 1}`;
    }
  }
  return undefined;
}

/** The named Python literals a result assigns, read with ast.literal_eval. */
export function pythonNames(code, names) {
  return JSON.parse(execFileSync("python3", ["-I", "-c", `
import ast, json, sys
names = {}
for node in ast.parse(sys.stdin.read()).body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        names[node.targets[0].id] = ast.literal_eval(node.value)
print(json.dumps({k: names[k] for k in ${JSON.stringify(names)}}))
`], { input: code }).toString());
}

/**
 * What a review ordered by a publisher records about the order: who paid, as the receipt shows it, and whether the
 * release itself names that payer, which is the one link between a publisher and a wallet that can be checked.
 */
export function publisherOrder(network, status, files, registry, tasks) {
  const { payer, payment, receipt } = verifiedPayer(network, status);
  const named = payerNamedIn(files, payer);
  return {
    party: "publisher",
    payer,
    payment,
    receipt,
    checked: Boolean(named),
    how: named
      ? `${named} names the paying address`
      : `Not checked: the release does not name the paying address, and ${registry} links no wallet to a publisher, so that the publisher paid rests on the order alone`,
    tasks,
  };
}
