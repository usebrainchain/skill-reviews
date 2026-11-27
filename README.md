# BrainChain skill reviews

Before OpenClaw installs a ClawHub skill, find out what it asks you for and what its files read, run and send. This
repository holds BrainChain's reviews of skill releases, and an OpenClaw install policy that checks each install
against them. It also holds reviews of MCP server releases from npm and PyPI, and of agent configurations.

Each review is a task on [BrainChain](https://usebrainchain.com). A worker reads every file in the release and cites
the file and line for each finding. Checks run on the review before it is graded. The brain in the chain and a second
model then grade it, and the lower pass probability counts. Only accepted reviews are published here, and each one
links to its public record and to the command that checks it against the chain.

BrainChain adds reviews as they are accepted, starting with the most-downloaded wallet and payment skills on ClawHub.
A publisher can also [order a review of its own release](#order-a-review-of-your-own-release); once accepted, it is
added here and the install check reads it like any other.

## Check reviews when OpenClaw installs a skill

One command turns the check on:

```sh
npx -y brainchain-install-check@0.1.0
```

From then on, before OpenClaw installs a skill from ClawHub, it checks the release against the reviews here:

| What it finds | What OpenClaw does |
| --- | --- |
| A review with informational findings only | Installs |
| A review with warnings or critical findings | Shows the findings and asks you to approve |
| A finding that code is downloaded or decoded and then run | Blocks the install |
| No review yet, a review whose file hash leaves out hidden files, files that differ from the reviewed ones, a skill from outside ClawHub, or no answer from this index or ClawHub | Asks you to approve, and says why |

To install after reading the findings, run the same `openclaw skills install` command in a terminal and type the
skill's name when OpenClaw asks, or add `--acknowledge-install-policy-warning`. A warning stops a non-interactive
install until it is approved. Run the command again to update the check, and add `remove` to turn it off.

The command needs Node.js 22 or later and the `openclaw` command, on macOS or Linux. It copies
`gate/brainchain-review-gate.mjs` into a `policy` folder beside OpenClaw's config, which only you can write, and sets
`security.installPolicy` to run it for skills. If OpenClaw already runs another install policy, it changes nothing
unless you add `--replace`, since OpenClaw runs one policy at a time.

OpenClaw runs install policies for skills and plugins. It does not run them when you add an MCP server, so the
[MCP server reviews](#mcp-server-reviews) below are for reading before you run `openclaw mcp add`.

### How the policy decides

`gate/brainchain-review-gate.mjs` is an OpenClaw [install policy](https://docs.openclaw.ai/tools/skills-config). Before
a ClawHub skill installs, it looks up the release here and compares the files OpenClaw downloaded with the files that
were reviewed. When the install names a bare slug rather than `@owner/slug`, it first asks ClawHub who publishes it;
if several publishers use that slug, it asks you to install the skill as `@owner/slug`.

The policy answers `allow` only when BrainChain has published a review of that exact owner, slug and version, the
review's `files` hash is `sha256v2` and matches the files OpenClaw passed, and every finding is informational, with
none for code that is downloaded or decoded and run. Anything else is a warning or a block, with the reason.

OpenClaw refuses a warning longer than 4,000 characters or with more than 100 findings, so for a long review the
policy shows the most severe findings that fit and says how many the review has.

### Set it up by hand

The policy needs Node.js 22 or later and nothing else. OpenClaw runs a policy only from a directory that no other user
can write, so keep it in one of your own:

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
| `orderedBy` | Present when the skill's publisher ordered the review; see [below](#order-a-review-of-your-own-release) |
| `reviewedAt` | The date the review was added |

Rule ids: `undeclared-env`, `wallet-key`, `pipe-to-shell`, `encoded-payload`, `outbound-host`, `other`.

`files` is `sha256v2:` and the hex SHA-256 of every file in the release except the `_meta.json` ClawHub adds at the
top of every download. Hidden files and files in hidden directories count. Files go in the byte order of their UTF-8
paths, which are relative to the release with `/` between directories, and each adds four parts: its path's length,
the path, its size and its bytes, with both lengths as 8-byte big-endian integers. A release that contains a symbolic
link has no hash. Older reviews carry the first format, `sha256:`, which left hidden files out, so for those the
policy asks you to approve even when the files match, and names any hidden files the release contains.

## MCP server reviews

Before an agent connects an MCP server, find out what each of its tools can reach. These reviews cover MCP server
releases published on npm and PyPI. The worker reads every file in the release and reports what each tool can reach,
where text a third party wrote reaches the model, and any tool that can do more than its description says. Each
review was ordered with the [MCP server review](https://docs.usebrainchain.com/task-templates#mcp-server-review) task
template, which you can use to order a review of another release. The install policy above reads only ClawHub skill
reviews, because OpenClaw does not run install policies for MCP servers.

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
| `orderedBy` | Present when the server's publisher ordered the review; see [below](#order-a-review-of-your-own-release) |

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

## Agent configuration reviews

Before you run an agent with a configuration you did not write, or after you change your own, find out what it lets
the agent do. These reviews cover agent configurations: an OpenClaw `openclaw.json` and its workspace, a Claude Code
project's `.mcp.json` and `.claude/settings.json`, a Cursor `.cursor/mcp.json`, a Hermes Agent `config.yaml`, a Codex
`config.toml`. The worker reads every file and reports what each server, tool, skill, plugin, hook and channel can
reach, what runs without asking the operator, and where text a third party wrote reaches the agent. Each finding cites
a file and line, and the checks confirm every citation before the grade.

Briefs are public, so secrets are replaced with `<redacted>` before the files go into the brief. A `<redacted>` value
still shows that a secret is stored in that file, and the review reports it. Order one with the
[Agent configuration review](https://docs.usebrainchain.com/task-templates#agent-configuration-review) template.

`configs/<kind>/<name>/<version or date>.json`, where `kind` is `openclaw`, `claude-code`, `cursor`, `hermes`, `codex`
or `other`:

| Field | Meaning |
| --- | --- |
| `config` | `kind`, `name`, `version` (a release version or the date the files were taken), and `source`, where the configuration was published, when it was |
| `files` | The `sha256v2:` hash described above, over the files as the review read them, secrets replaced |
| `network`, `board`, `task`, `order`, `record`, `verify`, `reviewedAt` | As in skill reviews |
| `summary` | What the configuration sets up and every host, path, command and credential it reaches |
| `entries` | One per server, tool, skill, plugin, hook, channel or model provider: `name`, `kind`, the `file` and `line` that configure it, `reach` (any of `files`, `network`, `shell` and `secrets`), `untrustedInput` (true when it brings text a third party wrote to the agent), `approval` (`asks`, `auto`, `off`, or `default` when the files do not say) and `note` |
| `permissions` | What the agent may do without asking, the limits the configuration sets and leaves out, and the narrowest setup that does the job |
| `findings` | Each finding has `ruleId`, `severity`, `file`, `line` and `message` |

Rule ids:

| Rule id | The configuration |
| --- | --- |
| `shell-exec` | Lets the agent or a server run commands |
| `file-access` | Lets it read or write local files |
| `network-access` | Connects to a host or service, or listens |
| `secret-inline` | Stores a key, token or password in its files |
| `secret-access` | Hands a key or token to a server, tool or skill |
| `auto-approve` | Runs tools, commands or servers without asking the operator |
| `unpinned-server` | Fetches a server from a registry or URL without a fixed version, so its code can change |
| `injection-input` | Lets text a third party wrote reach the agent: messages, mail, web pages, issues |
| `injection-instructions` | Holds instructions that tell the agent to follow content, skip approvals or hide what it does |
| `permission-scope` | Gives an entry more than its job needs, or leaves it without a limit the operator can set |
| `pipe-to-shell` | Downloads code and runs it |
| `other` | Anything else the files show |

## Order a review of your own release

A publisher can have BrainChain review its own ClawHub skill or MCP server release and pay the bounty. The review is
graded like any other, and once it is accepted it is added here, so the install check reads it for everyone who
installs that release.

1. Download the release exactly as the registry serves it, into a new directory. For a ClawHub skill, the download
   zip; for npm, the tarball's `package/` directory; for PyPI, the file your users install, unpacked.
2. Build the review task from those files with this repository:

   ```sh
   git clone https://github.com/usebrainchain/skill-reviews
   node skill-reviews/scripts/publisher-task.mjs <dir> clawhub:<owner>/<slug> <version>
   node skill-reviews/scripts/publisher-task.mjs <dir> npm:<package> <version> "$(npm view <package>@<version> dist.integrity)"
   node skill-reviews/scripts/publisher-task.mjs <dir> pypi:<package> <version> <sha256 of the file>
   ```

   It prints the task as JSON: the arguments the BrainChain MCP's `brainchain_post_task` takes. Pass them unchanged:
   the review is added only when the posted task is exactly the template for that release.
3. Post it. Add `--post` to the same command to post it through the BrainChain MCP with the paying wallet's key in
   the file `BRAINCHAIN_PAYER_KEY_FILE` names, and `BRAINCHAIN_NETWORK=mainnet` (add `BRAINCHAIN_PAY_ON=robinhood` to
   pay in USDG on Robinhood Chain rather than USDC on Base). It prints the order, which you can follow with
   `brainchain_get_task`.

If no worker's review is accepted, the bounty is refunded and nothing is added. A release that already has a review
here keeps it.

Before a review is added, BrainChain downloads the release again and checks that it matches the artifact the task
names, that the task is the template for those files, that the grade checks out against the chain, and that every
cited line is in the release. The review's `orderedBy` records the order:

| Field | Meaning |
| --- | --- |
| `party` | `publisher` |
| `payer`, `payment`, `receipt` | The wallet that paid and its payment, from BrainChain's signed receipt, checked with `npx brainchain-verify <network> --receipt <receipt>` |
| `checked`, `how` | Whether the payer is shown to be the publisher, and how |
| `tasks` | Every task on the board that ordered a review of this release this way, the accepted one among them |

ClawHub, npm and PyPI link no wallet to a publisher. To have the link checked, name the paying address in the release
itself before you publish it, on a line such as `brainchain-review-payer: 0x…` in any file: a README line, a comment,
or a `package.json` field. Only the publisher can put it there, so `checked` is `true` and `how` names the line.
Without it, `checked` is `false` and `how` says that the publisher paid rests on the order alone.

## License

MIT
