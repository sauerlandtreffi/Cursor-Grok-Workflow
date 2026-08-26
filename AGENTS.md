# AGENTS.md — Cursor-Grok-Workflow

You are reading the entry point for **`cursor-w`**: a skill that lets you dispatch up
to 10 Cursor Agent CLI subagents in parallel and verify what they actually did.

**`SKILL.md` in this directory is the full operating doctrine. Read it before you
dispatch anything.** This file is the short orientation for Codex and other
AGENTS.md-based harnesses.

## In one paragraph

Subagents do the labour. You do the thinking. They read, they type, they run commands
— they never judge their own work, and you never take their word for it. The worker
model is pinned by the runner to the newest Grok (`cursor-grok-4.6-high-fast`) and
**only** Grok: never Anthropic (Opus/Sonnet/Haiku), never OpenAI (GPT/o-series), never
any other vendor, and never an older or lower-effort Grok slug. **A subagent result is
a proposal, never a fact.**

## Prerequisites

```bash
curl https://cursor.com/install -fsS | bash    # `agent` lands in ~/.local/bin
agent login                                    # once, interactive
agent status                                   # confirm
```

Node ≥ 18. Works on Linux, macOS and Windows (see the Windows note in `SKILL.md`).

## Install as a skill

Copy this directory to wherever your harness keeps skills — both of these use the
identical `SKILL.md` layout:

```
~/.codex/skills/cursor-w/      # Codex
~/.claude/skills/cursor-w/     # Claude Code
```

`./install.sh` does it for every harness it finds. If your harness has no skill
directory, that is fine: nothing here depends on being installed. Point yourself at
`SKILL.md` and run `cursor-fan.mjs` by absolute path.

## The loop, every time

1. **Read `SKILL.md` in full.** It holds the hard rules, the task-file contract, and
   the verification protocol.
2. **Write a task file** — a JSON array of tasks. Start from `examples/`.
3. **Dispatch once:**
   ```bash
   node cursor-fan.mjs --tasks-file wave.json --out-dir wave-out --default-cwd /abs/path/to/project
   ```
   The runner parallelizes. Never fan out at your own tool level.
4. **Read `wave-out/_summary.json` FIRST.** Two flags decide whether a result is even
   worth reading:
   - `suspectNoToolCall: true` (`toolCalls == 0`) — it never looked at anything. If the
     task needed to, the answer is fabricated until you prove otherwise.
   - `rejectedToolCalls > 0` — the environment **refused** the work. Measured: a shell
     command without `--force` is rejected while the run still reports success with
     exit 0. The answer describes something that never ran.
5. **Verify yourself.** Open the files. Run the proof command. Act only on
   `structuredOutput`, never on prose.

## The six rules you will regret ignoring

0. **Grok only, newest generation.** Every subagent runs the pinned model. Foreign
   models — Anthropic Opus/Sonnet/Haiku, OpenAI GPT or o-series, Gemini, anything else
   `agent --list-models` offers — are forbidden outright, as is downgrading to an older
   or lower-effort Grok. The runner rejects `model` / `effort` fields instead of
   honouring them. If the pin cannot be met, abort the wave and report it; do not
   substitute.

1. **Prompts are self-contained.** A subagent has never seen your conversation and
   cannot ask questions. Absolute paths, what to read first, acceptance criteria.
   End every prompt with: *"if something is ambiguous, state it and pick the most
   conservative reading — you cannot ask questions."*
2. **Ask for the unguessable.** Exact line numbers, character-exact strings, real
   command output. That is what makes fabrication impossible instead of merely unlikely.
3. **`permissionMode: "force"` for anything that writes or runs commands.** Measured:
   without it, edits still land but *every shell command is rejected* — and the run
   still reports success. Any task with a proof command is worthless without it. The
   runner refuses writing modes without it.
4. **Never verify by asking another subagent** — with one exception: a *blind*
   verifier that has never seen the writer's claims. Run the proof command yourself
   regardless.
5. **Writers must be disjoint.** Tasks run concurrently. Two writers on one file
   clobber each other; sequence them with `after`.

## Quick reference

| | |
|---|---|
| Runner | `node cursor-fan.mjs --tasks-file W.json --out-dir OUT [--default-cwd DIR] [--max-parallel 10] [--dry-run]` |
| Modes | `read` (default, read-only) · `plan` · `write` · `shell` · `full` |
| Dependencies | `after: "<id>"` · `afterAny: true` runs even if the dependency failed (verifiers) |
| Structured output | `schema: <JSON Schema>` → parsed and checked; act on `structuredOutput` |
| Corrective round | `resumeSessionId: "<sessionId from _summary.json>"` — keeps context, so state only what is wrong |
| Statuses | `ok` · `schema-mismatch` · `skipped` · `unparsable` · `failed` · `timeout` |
| Refused fields | `model`, `effort` (pinned to the newest Grok — no Anthropic/OpenAI/other vendor, no downgrade), `maxTurns` (no such flag in this CLI) |
| Watch out | the subagent's `PATH` is not yours — Cursor's bundled Node shadows your own. Pin the toolchain by absolute path in proof commands that depend on a version. |
| Binary override | env `CURSOR_AGENT_ENTRY` |

Full field reference, the writer + blind-verifier pattern, the prompt template, and
the nine measured CLI behaviours that break naive integrations: **`SKILL.md`**.
