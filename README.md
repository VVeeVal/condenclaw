# CondenClaw

`condenclaw` is a log condenser for OpenClaw agents. It reconstructs a clear timeline without noise, saving up to 99.9% (yes really) in token costs during debugging.

Even for simple failures default tool tail pulls all the logs resulting in hundreds of thousands of tokens polluting your context. Condenclaw gives exactly the same outcome in under a thousand. 

## Installation

Install globally via npm:
```bash
npm install -g condenclaw
```

Show help:
```bash
condenclaw --help
```

## OpenClaw Configuration

To save massively on tokens, add this to your `AGENTS.md` or system rules:

> "NEVER use `tail` to read your own session logs. When debugging or explaining a failure, ALWAYS run `condenclaw --limit -1` first for a structured overview. Use `condenclaw --limit -1 -v` for detailed event payloads, and `condenclaw --limit -1 --raw-event <n>` when you need the exact raw event that looks suspicious."

## Bootstrap Prompt

Use this as a one-shot bootstrap prompt for an OpenClaw agent:

```text
Install and configure CondenClaw for this machine.

1. Run `npm install -g condenclaw`.
2. Run `condenclaw --help` and confirm the command is available.
3. Update my OpenClaw agent rules (`AGENTS.md`, system rules, or equivalent persistent instruction file) with this rule:

"NEVER use `tail` to read your own session logs. When debugging or explaining a failure, ALWAYS run `condenclaw --limit -1` first for a structured overview. Use `condenclaw --limit -1 -v` for detailed event payloads, and `condenclaw --limit -1 --raw-event <n>` when you need the exact raw event that looks suspicious."
```

## Usage

Analyze the latest agent activity:
```bash
# Debug the latest run for your default OpenClaw agent
condenclaw --limit -1

# Debug the latest run for a specific agent
condenclaw --agent worker --limit -1

# Show the first 3 runs with detailed tool inputs and outputs
condenclaw --limit 3 -v

# Pull the exact raw payload for suspicious events 3 and 7
condenclaw --limit -1 --raw-event 3,7

```

## Layered Debugging

`condenclaw` is designed to be used in layers so agents can stay token-efficient until they need exact evidence:

1. Condensed timeline: `condenclaw --limit -1`
2. Detailed event view: `condenclaw --limit -1 -v`
3. Exact raw event payloads: `condenclaw --limit -1 --raw-event 3` or `--raw-event 3,7`

## Commands & Flags

| Flag | Description |
| :--- | :--- |
| `[file]` | Path to a log file or session JSONL. Defaults to the latest session for your default OpenClaw agent. |
| `--limit <N>` | Limit runs shown. Use negative numbers for latest (e.g. -1 is latest). |
| `--agent <id>` | Read sessions for a specific OpenClaw agent instead of the default agent. |
| `--session-dir <path>` | Override the session directory used for local session discovery. |
| `--session <path>`| Explicitly analyze a specific OpenClaw session JSONL file. |
| `--raw-event <numbers>` | Show exact raw payloads for specific 1-based event numbers, e.g. `3` or `3,7`. |
| `-v, --verbose` | Show the detailed event layer with expanded tool inputs and outputs. |
| `--json` | Output the behavioral timeline in machine-readable JSON. |
| `-h, --help` | List commands, flags, and usage examples. |
