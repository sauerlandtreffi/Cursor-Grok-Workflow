# Cursor-Grok-Workflow (`cursor-w`)

**Hand the grunt work to ten Cursor agents at once. Keep every decision yourself.**

This is a skill for coding agents — Claude Code, Codex, or any harness that can read
a `SKILL.md` and run a Node script. It lets your agent dispatch up to 10 Cursor Agent
CLI subagents in parallel (running Grok), each with its own task, and then verify what
they actually did.

Ported from [grok-w](https://github.com/sauerlandtreffi/grok-w), which does the same
thing with the xAI Grok Build CLI.

---

## Why this exists

Fanning out work to subagents is easy. Trusting the answers is not.

> The model will report success for work it never performed. Not occasionally, and not
> in a way that looks like failure.

grok-w measured this on grok-4.6 across 22 real tasks: a `node --version` it never ran
(and got wrong), files it claimed to have written that were never on disk, facts
"extracted" from a file it never opened. Every one came back schema-valid, confident,
and `status: ok`.

So this is not a thin fan-out wrapper. **The verification is the product.**

The tell is mechanical, and Cursor makes it directly observable: its `stream-json`
output emits an event per tool call, so the runner counts them.

> **A task that needed to look at the world, and made zero tool calls, made its answer up.**

The runner flags that as `suspectNoToolCall`. The doctrine treats a flagged result as
fabricated until you prove otherwise — by opening the files and running the proof
command yourself.

The second defence is prompt design: **ask for something the model cannot know.**
Exact line numbers. Strings copied character-for-character. The real output of a
command. There is nothing to guess, so the only way to answer is to actually look.

---

## Install

**1. Install the Cursor Agent CLI and log in** (once):

```bash
curl https://cursor.com/install -fsS | bash    # installs `agent` into ~/.local/bin
agent login                                    # opens a browser
agent status                                   # should print your account
```

You also need Node ≥ 18.

**2. Install the skill:**

```bash
git clone https://github.com/sauerlandtreffi/Cursor-Grok-Workflow
cd Cursor-Grok-Workflow
./install.sh            # copies the skill into every harness it finds
```

Or copy the directory by hand — same files, both harnesses use the same layout:

| Harness | Destination |
|---|---|
| Claude Code | `~/.claude/skills/cursor-w/` |
| Codex | `~/.codex/skills/cursor-w/` |
| Anything else | anywhere — point your agent at `SKILL.md` |

**3. Use it.** Say `Cursor-W` in a message, anywhere, any casing. That word is the
trigger; typing it *is* the opt-in.

> "Cursor-W: audit every endpoint in src/api for missing auth checks."

---

## What your agent actually does

```
YOU ──▶ your agent (the ORCHESTRATOR — owns every judgement)
             │  writes wave.json: up to 10 independent tasks
             ▼
        node cursor-fan.mjs --tasks-file wave.json --out-dir wave-out
             │  runs ≤10 `agent` processes in parallel, in dependency order
             ▼
        wave-out/_summary.json   ◀── read this FIRST
             │  status · toolCalls · suspectNoToolCall · sessionId
             ▼
        your agent opens the real files and runs the proof command itself
```

Nothing below the runner plans, judges, or verifies its own work. It reads, it types,
it runs commands. Everything above the runner is yours.

---

## A wave is just a JSON file

```json
[
  {
    "id": "auth-audit",
    "mode": "read",
    "cwd": "/abs/path/to/project",
    "prompt": "CONTEXT\n  Read src/api/*.ts.\n\nTASK\n  Find every endpoint with no auth check.\n\nACCEPTANCE\n  For each: file, 1-based line number, and the exact line copied character-for-character.\n\nCONSTRAINTS\n  Change nothing. You cannot ask questions.",
    "schema": {
      "type": "object",
      "required": ["findings"],
      "properties": { "findings": { "type": "array" } }
    }
  }
]
```

```bash
node cursor-fan.mjs --tasks-file wave.json --out-dir wave-out
```

Note what that prompt asks for: line numbers and character-exact source. Both are
unguessable, so the task can only be answered by actually reading. That is the point.

`--dry-run` prints the exact command lines and spends nothing.

---

## The one pattern worth learning: writer + blind verifier

```json
[
  { "id": "fix", "mode": "full", "permissionMode": "force", "cwd": "/repo",
    "prompt": "<frozen spec>" },

  { "id": "fix-verify", "mode": "shell", "permissionMode": "force", "cwd": "/repo",
    "after": "fix", "afterAny": true,
    "prompt": "Inspect the working tree of /repo and run: <proof command>. Judge only what you can observe. Report fail if the work is absent, incomplete, or the command does not pass.",
    "schema": { "type": "object", "required": ["verdict", "evidence"],
      "properties": { "verdict": { "type": "string", "enum": ["pass", "fail"] },
                      "evidence": { "type": "string" } } } }
]
```

The verifier runs *after* the writer and is never shown what the writer said — the
runner does not feed a dependency's output into a dependent prompt. It judges disk
state and the proof command, nothing else.

**A verifier that has seen the writer's claims is not a verifier.**

---

## What is in here

| File | |
|---|---|
| `SKILL.md` | The operating doctrine your agent reads: the hard rules, the task-file contract, the verification protocol. |
| `AGENTS.md` | The same entry point for Codex and other AGENTS.md-based harnesses. |
| `cursor-fan.mjs` | **The runner.** Plain Node, no dependencies. Runs the wave, writes the summary. |
| `cursor-fanout.js` | Optional pipeline for implementation work, for harnesses with a `Workflow` tool. |
| `examples/` | Two working task files: a schema-driven audit wave, and the writer + blind-verifier pattern. |
| `install.sh` | Copies the skill into `~/.claude/skills/` and `~/.codex/skills/`. |

---

## The model is pinned

`grok-4.6[effort=high,fast=true]` — high reasoning effort, fast output. Cursor
expresses effort and speed as bracket parameters on the model id; the CLI documents
the form itself (`--model 'claude-opus-4-8[context=1m,effort=high,fast=false]'`).

The runner **refuses** a per-task `model` or `effort` field rather than ignoring it.
A silently dropped override is exactly the class of failure this thing exists to
prevent. There is nothing to configure and nothing to choose.

---

## Guardrails the runner enforces

Each of these would otherwise be a silent no-op that still reports success:

| | |
|---|---|
| **`force` or it did not happen.** Anything that writes or runs a command needs `permissionMode: "force"` (`--force`). Without it the agent must ask for approval, and headless there is nobody to ask. | Writing modes are **refused** under any other permission mode. |
| **Read means read.** A `read` task under `--force` has nothing stopping it from editing files. | `mode: "read"` is **refused** under `permissionMode: "force"`. |
| **No fake knobs.** Cursor has no `--max-turns`, no `--json-schema`, no `--prompt-file`. | A `maxTurns` field is **refused** with an explanation, not quietly dropped. |
| **Structured output is a contract, not a hope.** With no `--json-schema` flag, the runner appends the schema to the prompt, then parses and checks the answer on the way back. | A miss is status `schema-mismatch` with the specific problem — never a half-parsed object. |
| **Windows shims corrupt prompts.** A `.cmd`/`.ps1` shim re-parses its arguments and destroys a multi-line prompt. | The runner **refuses** to run through one. Point `CURSOR_AGENT_ENTRY` at the real executable. |

---

## What is tested, and what is not

**Tested end-to-end** against a stub CLI that speaks the real event format: tool-call
counting, the suspect flag, JSON extraction (fenced and prose-wrapped), schema
checking, the dependency scheduler including `skipped` and `afterAny`, per-task
timeouts with process-group kill, non-zero exits, and every refusal path.

**Verified against the shipped Cursor binary** (`2026.08.11-e8db854`): `--allowed-tools`,
`--exclude-tools`, `--system-prompt`, `--single-turn` and `--new-session-id` exist but
are hidden; `--max-turns`, `--json-schema`, `--prompt-file`, `--deny` and
`--no-subagents` do not exist at all. The result event's shape was read out of the
shipped bundle.

**Not yet proven**, because it needs an authenticated account — confirm on your first
real wave: that `grok-4.6[effort=high,fast=true]` is accepted (`agent --list-models`);
that `--mode ask` grounds a read task in the files rather than refusing to use tools;
that `tool_call` events carry the lifecycle `subtype` the runner assumes; and this
model's fabrication rate under this CLI. Until then the doctrine is inherited from
grok-w's measurements, not re-measured here.

The POSIX paths are exercised on Linux. Windows follows standard Node behaviour but
has not been run.

---

## License

MIT — see `LICENSE`.
