# BrainChain skill reviews

Before OpenClaw installs a ClawHub skill, find out what it asks you for and what its files read, run and send. This
repository holds BrainChain's reviews of skill releases, and an OpenClaw install policy that checks each install
against them.

Each review is a task on [BrainChain](https://usebrainchain.com). A worker reads every file in the release and cites
the file and line for each finding. Checks run on the review before it is graded. The brain in the chain and a second
model then grade it, and the lower pass probability counts. Only accepted reviews are published here, and each one
links to its public record and to the command that checks it against the chain.

BrainChain adds reviews as they are accepted, starting with the most-downloaded wallet and payment skills on ClawHub.

## Check reviews when OpenClaw installs a skill

`gate/brainchain-review-gate.mjs` is an OpenClaw [install policy](https://docs.openclaw.ai/tools/skills-config). Before
a ClawHub skill installs, it looks up the release here and compares the files OpenClaw downloaded with the files that
were reviewed. When the install names a bare slug rather than `@owner/slug`, it first asks ClawHub who publishes it;
if several publishers use that slug, it asks the operator to install the skill as `@owner/slug`.

| What it finds | What OpenClaw does |
| --- | --- |
| A review with informational findings only | Installs, and shows the findings |
| A review with warnings or critical findings | Shows the findings and asks the operator to approve |
| A finding that code is downloaded or decoded and then run | Blocks the install |
| No review yet, a review whose file hash leaves out hidden files, files that differ from the reviewed ones, a skill from outside ClawHub, or no answer from this index or ClawHub | Asks the operator to approve, and says why |

The policy answers `allow` only when BrainChain has published a review of that exact owner, slug and version, the
review's `files` hash is `sha256v2` and matches the files OpenClaw passed, and every finding is informational, with
none for code that is downloaded or decoded and run. Anything else is a warning or a block, with the reason.

OpenClaw refuses a warning longer than 4,000 characters or with more than 100 findings, so for a long review the
policy shows the most severe findings that fit and says how many the review has.

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

### Run it by hand

The policy reads one request on stdin and writes one answer on stdout, so you can try it on a reviewed release without
OpenClaw. Download the release from ClawHub into a new directory:

```sh
cd "$(mktemp -d)"
curl -fsSL "https://clawhub.ai/api/v1/download?slug=trust-escrow&ownerHandle=droppingbeans&version=1.0.0" -o release.zip
unzip -q release.zip -d release
```

For another release, change `slug`, `ownerHandle` and `version`. ClawHub needs `ownerHandle` only when more than one
publisher uses the slug.

Then send the policy a request shaped like the one OpenClaw sends:

```sh
cat > request.json <<EOF
{
  "sourcePath": "$PWD/release",
  "sourcePathKind": "directory",
  "origin": { "type": "clawhub", "ownerHandle": "droppingbeans", "slug": "trust-escrow", "version": "1.0.0" }
}
EOF
node ~/.openclaw/policy/brainchain-review-gate.mjs < request.json
```

The answer is one line of JSON, formatted and shortened here:

```json
{
  "protocolVersion": 1,
  "decision": "warn",
  "reason": "BrainChain reviewed droppingbeans/trust-escrow 1.0.0: 8 findings, 1 critical. Review: https://brain.testnet.usebrainchain.com/records/0xf0e75ef9f2ceebf93660a009c7cd7142e53334879e405b1dbf8c2b0ae693a606.txt",
  "findings": [
    {
      "ruleId": "brainchain/wallet-key",
      "severity": "critical",
      "message": "The workflow example calls privateKeyToAccount('0xYOUR_PRIVATE_KEY'), instructing the operator to supply a raw wallet private key for signing transactions in plaintext.",
      "file": "SKILL.md",
      "line": 216
    }
  ]
}
```

## What a review covers

A review reports what the release's files show: the keys and wallets it asks for, the environment variables it reads
that its metadata does not declare, the hosts it talks to, and any code it fetches or decodes and runs. It does not
watch the skill run, so it cannot see code the skill downloads later. Each review names the network it ran on; the
first ones ran on BrainChain testnet.

## Review files

`reviews/<owner>/<slug>/<version>.json`:

| Field | Meaning |
| --- | --- |
| `release` | The ClawHub owner, slug and version reviewed |
| `files` | A hash of every file in the release, hidden files included; see below |
| `network`, `board`, `task`, `order` | Where the review was done and paid for. Task ids start again with each contract set, so `board` names the TaskBoard the task is on |
| `record` | The accepted review, as BrainChain serves it |
| `verify` | Checks the hire and the grade against the chain: `npx brainchain-verify <network> --task <id> --set <board>` |
| `summary`, `findings` | What the review found; each finding has `ruleId`, `severity`, `file`, `line` and `message` |
| `reviewedAt` | The date the review was added |

Rule ids: `undeclared-env`, `wallet-key`, `pipe-to-shell`, `encoded-payload`, `outbound-host`, `other`.

`files` is `sha256v2:` and the hex SHA-256 of every file in the release except the `_meta.json` ClawHub adds at the
top of every download. Hidden files and files in hidden directories count. Files go in the byte order of their UTF-8
paths, which are relative to the release with `/` between directories, and each adds four parts: its path's length,
the path, its size and its bytes, with both lengths as 8-byte big-endian integers. A release that contains a symbolic
link has no hash. Older reviews carry the first format, `sha256:`, which left hidden files out, so for those the
policy asks the operator to approve even when the files match, and names any hidden files the release contains.

## License

MIT
