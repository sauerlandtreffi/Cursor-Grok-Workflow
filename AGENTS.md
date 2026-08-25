# AGENTS.md — Cursor-Grok-Workflow

You are reading the entry point for **`cursor-w`**: a skill that lets you dispatch up
to 10 Cursor Agent CLI subagents in parallel and verify what they actually did.

**`SKILL.md` in this directory is the full operating doctrine. Read it before you
dispatch anything.** This file is the short orientation for Codex and other
AGENTS.md-based harnesses.

## In one paragraph

Subagents do the labour. You do the thinking. They read, they type, they run commands
— they never judge their own work, and you never take their word for it. The model is
pinned to `grok-4.6[effort=high,fast=true]` by the runner. **A subagent result is a
proposal, never a fact.**

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
4. **Read `wave-out/_summary.json` FIRST.** A task with `suspectNoToolCall: true`
   (that is, `toolCalls == 0`) made zero tool calls: if it needed to look at anything,
   the answer is fabricated until you prove otherwise.
5. **Verify yourself.** Open the files. Run the proof command. Act only on
   `structuredOutput`, never on prose.

## The five rules you will regret ignoring

1. **Prompts are self-contained.** A subagent has never seen your conversation and
   cannot ask questions. Absolute paths, what to read first, acceptance criteria.
   End every prompt with: *"if something is ambiguous, state it and pick the most
   conservative reading — you cannot ask questions."*
2. **Ask for the unguessable.** Exact line numbers, character-exact strings, real
   command output. That is what makes fabrication impossible instead of merely unlikely.
3. **`permissionMode: "force"` for anything that writes or runs commands.** The runner
   refuses writing modes without it, because without it nothing reaches the disk while
   the task still reports an answer.
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
| Refused fields | `model`, `effort` (pinned), `maxTurns` (no such flag in this CLI) |
| Binary override | env `CURSOR_AGENT_ENTRY` |

Full field reference, the writer + blind-verifier pattern, the prompt template, and
what is measured versus assumed: **`SKILL.md`**.
