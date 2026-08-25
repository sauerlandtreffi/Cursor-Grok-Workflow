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

**A second tell had to be added for Cursor**, and it is the more useful one. Measured
live: a shell command dispatched without `--force` comes back `rejected` — five
attempts, every one refused — while the process still exits **0** with
`subtype: "success"` and `is_error: false`. The task made five tool calls, so the
zero-tool-call flag never fires, and nothing in the machine-readable result says the
work was blocked. Only the event stream knows:

> **`rejectedToolCalls > 0` ⇒ the environment refused the work. The answer describes
> something that never ran.**

The third defence is prompt design: **ask for something the model cannot know.**
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

`cursor-grok-4.6-high-fast` — Grok 4.6 at high reasoning effort, fast output.

Cursor bakes effort and speed into the model slug itself. There is no `--effort` flag,
and the bracket form the `--help` text advertises is not how these ids are written —
`agent --list-models` gives the real ones
(`cursor-grok-4.6-{low,medium,high,xhigh}[-fast]`).

The runner **refuses** a per-task `model` or `effort` field rather than ignoring it.
A silently dropped override is exactly the class of failure this thing exists to
prevent. There is nothing to configure and nothing to choose.

---

## Guardrails the runner enforces

Each of these would otherwise be a silent no-op that still reports success:

| | |
|---|---|
| **`force` or it did not happen.** Measured: without `--force`, edits still land — but **every shell command is rejected**, and the run still reports success. Any task with a proof command is worthless without it. | Writing modes are **refused** under any other permission mode, and rejections are counted and reported. |
| **Read means read.** A `read` task under `--force` has nothing stopping it from editing files. | `mode: "read"` is **refused** under `permissionMode: "force"`. |
| **No fake knobs.** Cursor has no `--max-turns`, no `--json-schema`, no `--prompt-file`. | A `maxTurns` field is **refused** with an explanation, not quietly dropped. |
| **Structured output is a contract, not a hope.** With no `--json-schema` flag, the runner appends the schema to the prompt, then parses and checks the answer on the way back. | A miss is status `schema-mismatch` with the specific problem — never a half-parsed object. |
| **Windows shims corrupt prompts.** A `.cmd`/`.ps1` shim re-parses its arguments and destroys a multi-line prompt. | The runner **refuses** to run through one. Point `CURSOR_AGENT_ENTRY` at the real executable. |

---

## What was measured

Run live against a real account (Cursor CLI `2026.08.11-e8db854`,
`cursor-grok-4.6-high-fast`). Each of these silently breaks a naive integration:

1. **Without `--force`, edits execute but shell commands are rejected** — five
   attempts, every one refused, process still exits 0 with `subtype: "success"`.
2. **The subagent's `PATH` is not yours.** Cursor's bundled Node shadows your own: a
   subagent reported `node --version` as `v24.5.0` where the parent shell had
   `v24.12.0`. It really had run the command — the answer was correct *for its
   environment*. **This looks exactly like fabrication if you do not check.** Pin the
   toolchain by absolute path in any proof command that depends on the version.
3. **Subagents inherit your harness's rules and skills** as workspace context. One
   dispatch spent a read on `~/.claude/skills/cursor-w/SKILL.md` before starting its
   real job.
4. **`--exclude-workspace-context` is server-gated.** Without the entitlement *every*
   task dies with `[invalid_argument] Workspace context exclusion is not allowed for
   this user, team, or selected model`. So `stripWorkspaceContext` is opt-in.
5. **`tool_call` events come in `started`/`completed` pairs** — the runner counts
   starts, so `toolCalls` is the real number.
6. **`--mode ask` genuinely reads files:** asked for a random 20-character token and
   its line number, it returned both character-exact.
7. **Resume works headless and keeps context:** a corrective round extended the file
   the session had created earlier, without being told the path again.
8. **These flags do not exist:** `--max-turns`, `--json-schema`, `--prompt-file`,
   `--deny`, `--no-subagents`. Hidden but real: `--allowed-tools`, `--exclude-tools`
   (both "internal only", taking protobuf field names), `--system-prompt`,
   `--single-turn`, `--new-session-id`.

**On fabrication:** across the live tasks run here — reads, writes, a blind verifier,
a corrective round — nothing was fabricated. Every claim matched disk. That is a small
sample on a different CLI than grok-w measured, so the doctrine stands as inherited,
not re-confirmed. **Keep verifying.** The one result that looked like fabrication was
finding 2, and it was the environment, not the model.

The runner itself is additionally tested against a stub CLI replaying real event
streams: tool-call and rejection counting, the suspect flag, JSON extraction (fenced
and prose-wrapped), schema checking, the dependency scheduler including `skipped` and
`afterAny`, per-task timeouts with process-group kill, non-zero exits, and every
refusal path.

POSIX paths are exercised on Linux. Windows follows standard Node behaviour but has
not been run.

## License

MIT — see `LICENSE`.
