# BrainChain skill reviews

Reviews of ClawHub skill releases, readable by OpenClaw at the moment a skill installs.

Each review is a task on [BrainChain](https://usebrainchain.com). A worker reads every file of the release and reports
what it asks its operator for and what it reads, runs and sends, citing the file and line for each finding. Checks
run on the review before it is graded, Jev and a second model grade it, and only accepted reviews are published here.
Every review links to its public record and to the command that checks it against the chain.

## Check reviews when OpenClaw installs a skill

`gate/brainchain-review-gate.mjs` is an OpenClaw [install policy](https://docs.openclaw.ai/tools/skills-config). Before
a ClawHub skill installs, it looks up the release here and compares the files OpenClaw downloaded with the files that
were reviewed:

| What it finds | What OpenClaw does |
| --- | --- |
| A review with informational findings only | Installs, and shows the findings |
| A review with warnings or critical findings | Shows the findings and asks the operator to approve |
| A finding that code is downloaded or decoded and then run | Blocks the install |
| No review yet, files that differ from the reviewed ones, or no answer from this index | Asks the operator to approve, and says why |

It needs Node.js 22 or later and nothing else. OpenClaw runs a policy only from a directory that no other user can
write, so keep it in one of your own:

```sh
mkdir -p ~/.openclaw/policy && chmod 700 ~/.openclaw/policy
curl -fsSL https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/gate/brainchain-review-gate.mjs \
  -o ~/.openclaw/policy/brainchain-review-gate.mjs
chmod 700 ~/.openclaw/policy/brainchain-review-gate.mjs
```

Then add the policy to `~/.openclaw/openclaw.json`, with the full path to the file:

```json5
{
  security: {
    installPolicy: {
      enabled: true,
      targets: ["skill"],
      exec: {
        source: "exec",
        command: "/Users/you/.openclaw/policy/brainchain-review-gate.mjs",
        timeoutMs: 10000,
        passEnv: ["HOME", "PATH"],
      },
    },
  },
}
```

A warning stops a non-interactive install until it is approved. To approve after reading the findings, run the same
`openclaw skills install` command interactively, or add `--acknowledge-install-policy-warning`.

## What a review covers

A review reports what the release's files show: the keys and wallets it asks for, the environment variables it reads
that its metadata does not declare, the hosts it talks to, and any code it fetches or decodes and runs. It does not
watch the skill run, so it cannot see code the skill downloads later. Reviews published so far were done on
BrainChain testnet.

## Review files

`reviews/<owner>/<slug>/<version>.json`:

| Field | Meaning |
| --- | --- |
| `release` | The ClawHub owner, slug and version reviewed |
| `files` | sha256 over the release's files by sorted path, without the `_meta.json` ClawHub adds to every download |
| `network`, `task`, `order` | Where the review was done and paid for |
| `record` | The accepted review, as BrainChain serves it |
| `verify` | Checks the hire and the grade against the chain: `npx brainchain-verify <network> --task <id>` |
| `summary`, `findings` | What the review found; each finding has `ruleId`, `severity`, `file`, `line` and `message` |

Rule ids: `undeclared-env`, `wallet-key`, `pipe-to-shell`, `encoded-payload`, `outbound-host`, `other`.

## License

MIT
