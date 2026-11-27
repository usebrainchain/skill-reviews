---
name: brainchain-install-check
description: Check each ClawHub skill against BrainChain's line-by-line review before OpenClaw installs it, and read BrainChain's MCP server reviews before adding a server.
homepage: https://docs.usebrainchain.com/install-check
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["npx"] },
      },
  }
---

# BrainChain install check

With the check on, OpenClaw looks up every skill it is about to install from ClawHub in BrainChain's public reviews.
Each review reads every file of one exact release and reports, by file and line, the keys and wallets the skill asks
for, the hosts it talks to and any code it fetches or decodes and runs. OpenClaw compares the files it downloaded with
the reviewed ones, then:

| What it finds | What OpenClaw does |
| --- | --- |
| A review with informational findings only | Installs |
| A review with warnings or critical findings | Shows the findings and asks the owner to approve |
| A finding that code is downloaded or decoded and then run | Blocks the install |
| No review yet, files that differ, or a skill from outside ClawHub | Asks the owner to approve, and says why |

The reviews are at https://github.com/usebrainchain/skill-reviews. They report what the files show; they do not watch a
skill run.

## Turn it on

When the owner asks for the check, run this in a terminal, or ask the owner to run it if this agent has no shell:

```sh
npx -y brainchain-install-check@0.1.0
```

It needs Node.js 22 or later on macOS or Linux, and prints what it set. Running it again updates the check. Run
`npx -y brainchain-install-check@0.1.0 remove` or add `--replace` only when the owner asks for exactly that: the first
turns the check off, the second replaces another install policy the owner set up.

## When an install stops

1. Tell the owner the reason OpenClaw printed and each finding with its file and line, most severe first, and link the
   review it names. Say what the findings mean for this owner: a key it would hold, a host it would send data to, a
   command it would run.
2. Never add `--acknowledge-install-policy-warning` and never type the skill's name at OpenClaw's prompt yourself. The
   owner approves an install, after reading the findings.
3. A block is final. Never install a blocked release another way, such as by downloading or copying its files into a
   skills folder. Look for another skill that does the job, or a later release with its own review.
4. "No BrainChain review yet" means nobody has reviewed that release. Say so plainly; it is not a finding against the
   skill.

## Before adding an MCP server

OpenClaw does not run install checks for MCP servers, so look the release up before running `openclaw mcp add` or
`openclaw mcp set`. For an npm package, read
`https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/mcp/npm/<package>/<version>.json`, for example
`mcp/npm/@modelcontextprotocol/server-postgres/0.6.2.json`; for PyPI, use `mcp/pypi/` in its place. Add the server
pinned to the version you looked up.

- Found: tell the owner what each tool can reach (`files`, `network`, `shell`, `secrets`), which tools return text a
  third party wrote, the narrowest setup in `permissions`, and the warnings and critical findings with file and line.
  Then add the server only if the owner agrees.
- Not found (the address answers 404): tell the owner there is no BrainChain review of that release, and let them decide.

## Before suggesting a skill

To compare skills before suggesting one, read
`https://raw.githubusercontent.com/usebrainchain/skill-reviews/main/reviews/<owner>/<slug>/<version>.json` for each
candidate and mention what its review found. A 404 means no review yet.
