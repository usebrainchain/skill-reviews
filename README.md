# BrainChain skill reviews

Before OpenClaw installs a ClawHub skill, find out what it asks you for and what its files read, run and send. This
repository holds BrainChain's reviews of skill releases, and an OpenClaw install policy that checks each install
against them. It also holds reviews of MCP server releases from npm and PyPI.

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

## MCP server reviews

Before an agent connects an MCP server, find out what each of its tools can reach. These reviews cover MCP server
releases published on npm and PyPI. The worker reads every file in the release and reports what each tool can reach,
where text a third party wrote reaches the model, and any tool that can do more than its description says. Each
review was ordered with the [MCP server review](https://docs.usebrainchain.com/task-templates#mcp-server-review) task
template, which you can use to order a review of another release. The install policy above reads only ClawHub skill
reviews.

`mcp/<registry>/<package>/<version>.json`, for example
[`mcp/npm/@modelcontextprotocol/server-postgres/0.6.2.json`](mcp/npm/@modelcontextprotocol/server-postgres/0.6.2.json):

| Field | Meaning |
| --- | --- |
| `release` | `registry` (`npm` or `pypi`), `name`, `version`, and `artifact`, the exact download: npm's `dist.integrity`, or the SHA-256 of the PyPI file |
| `files` | The `sha256v2:` hash described above, over the release's unpacked files. For npm these are the contents of the tarball's `package/` directory |
| `network`, `board`, `task`, `order`, `record`, `verify`, `reviewedAt` | As in skill reviews |
| `summary` | What the server does and every host, path and credential it reaches |
| `tools` | One entry per tool: `name`, the `file` and `line` that define it, `reach` (any of `files`, `network`, `shell` and `secrets`), `untrustedOutput` (true when the tool returns text a third party wrote, such as web pages or database rows) and `note` |
| `permissions` | What the server runs with, the limits the operator can set, and the narrowest setup that works |
| `findings` | Each finding has `ruleId`, `severity` (`info`, `warn` or `critical`), `file`, `line` and `message` |

Rule ids:

| Rule id | The release |
| --- | --- |
| `shell-exec` | Runs commands or child processes |
| `file-access` | Reads or writes local files |
| `network-access` | Connects to a host or service |
| `secret-access` | Reads, stores or sends a key, token, password or credential |
| `injection-description` | Has a tool, prompt or resource description that instructs the model |
| `injection-output` | Returns text a third party wrote to the model |
| `permission-scope` | Has a tool that can do more than its description says or its task needs, or that the operator cannot limit |
| `pipe-to-shell` | Downloads code and runs it |
| `encoded-payload` | Decodes data and runs it |
| `other` | Anything else the files show |

## License

MIT
