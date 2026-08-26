---
name: cursor-w
description: Cursor Agent CLI subagents do the labour (pinned to the newest Grok, cursor-grok-4.6-high-fast — never Anthropic, OpenAI or any other foreign model); the invoking agent orchestrates and owns every judgement. Use whenever the user's message contains "Cursor-W", "cursor-w", "CursorW", "/cursor-w" or "Cursor-Grok-Workflow", any casing, anywhere. Shapes: single call, wave of up to 10 tasks via cursor-fan.mjs, or the cursor-fanout pipeline (Workflow tool).
---

# Cursor-W — orchestrated Cursor fan-out

**In one paragraph:** you hand batches of grunt work to up to 10 Cursor Agent CLI
subagents running Grok in parallel, and you keep every decision. They read, they
type, they run commands. They do not judge their own work, and neither do you take
their word for it — the runner records what each one *actually did*, and you check
the disk yourself. **A subagent result is a proposal, never a fact.**

**Trigger:** any message containing `Cursor-W` (any casing). Typing it *is* the
opt-in — run the protocol, don't ask.

**Prerequisites:** Node ≥ 18 and the Cursor Agent CLI, authenticated once:

```bash
curl https://cursor.com/install -fsS | bash    # installs `agent` into ~/.local/bin
agent login                                    # once, interactive (browser)
agent status                                   # should print your account
```

Files in this directory (`<skill dir>`): `cursor-fan.mjs` — the runner ·
`cursor-fanout.js` — optional Workflow pipeline · `examples/` — two working task files.

## The 60-second version

```bash
# 1. write a task file
cat > wave.json <<'EOF'
[{ "id": "audit", "mode": "read", "cwd": "/abs/path/to/project",
   "prompt": "CONTEXT\n  Read src/api/*.ts.\n\nTASK\n  List every endpoint with no auth check.\n\nACCEPTANCE\n  For each: file, 1-based line number, and the exact line copied character-for-character.\n\nCONSTRAINTS\n  Do not modify anything. You cannot ask questions.",
   "schema": { "type": "object", "required": ["findings"],
     "properties": { "findings": { "type": "array" } } } }]
EOF

# 2. run the wave
node <skill dir>/cursor-fan.mjs --tasks-file wave.json --out-dir wave-out

# 3. read wave-out/_summary.json FIRST, then verify the claims against the real files
```

## Why the verification is the whole point

Upstream (grok-w) measured this on grok-4.6 and it is not hypothetical: **the model
will report success for work it never performed.** Schema-valid, confident, and wrong
— a `node --version` it never ran, files it "wrote" that were never on disk, facts
"extracted" from a file it never opened.

The tell is mechanical: **the task needed a tool call and made none.** grok-w had to
infer that from a turn counter. Cursor's `stream-json` output emits a `tool_call`
event per tool call, so this runner counts the thing itself and reports it as
`toolCalls` plus the `suspectNoToolCall` flag.

> **`toolCalls == 0` on a task that needed to look at the world ⇒ treat the answer as
> fabricated until you have checked it yourself.**

**There is a second tell, and it is the one this port had to add.** Measured here: a
shell command dispatched without `--force` comes back `rejected` — five attempts, all
refused — while the process still exits **0** with `subtype: "success"` and
`is_error: false`. Nothing in the machine-readable result says the work was blocked,
and the task made five tool calls, so the zero-tool-call flag never fires. The event
stream is the only place the truth appears, so the runner counts it:

> **`rejectedToolCalls > 0` ⇒ the environment refused the work. The answer describes
> something that never ran.**

The third defence is prompt design: **ask for something the model cannot know.**
Exact line numbers, exact strings copied character-for-character, the real output of
a command. There is nothing to guess, so the only way to answer is to actually look.

## Map

```
ORCHESTRATOR (you) · scope → decompose → freeze specs → dispatch → verify → integrate
  │
  ├─ Shape 1 · single call     one-task wave — still gives _summary, suspect flag, sessionId
  ├─ Shape 2 · swarm wave      ≤10 disjoint tasks, dependency-ordered — the workhorse
  └─ Shape 3 · fanout pipeline (Workflow tool only) plan → harden specs
                               → per item: writer → blind verifier → proof
                               → independent diff review → accept / re-plan (≤2 rounds)
  │
  ▼
wave.json = [ { id, prompt, mode: read|plan|write|shell|full, cwd, after, afterAny,
                schema, timeoutSec, resumeSessionId, … } ]
  │
  ▼
cursor-fan.mjs — ≤10 parallel `agent` processes, honours `after`, enforces the model pin
  │              writer (mode full) ──after──► blind verifier (never sees writer's output)
  ▼
outdir/  _summary.json      status, toolCalls, rejectedToolCalls, suspectNoToolCall,
                            sessionId — read FIRST
         <id>.json          structuredOutput = the only field to act on
         <id>.stream.jsonl  the raw event stream — the evidence of what it really did
         <id>.err.txt       _prompts/<id>.txt
  │
  ▼
ORCHESTRATOR verifies: open the files, run the proof command itself.
toolCalls==0 ⇒ fabricated ⇒ corrective round via resumeSessionId (max 2, then do it yourself)
```

## The worker is fixed: `cursor-grok-4.6-high-fast`

Standing instruction, enforced by the runner. Per-task `model` / `effort` fields are
**refused** rather than ignored.

Cursor bakes effort and speed into the model slug itself; there are no `--effort` or
`--fast` flags, and the bracket-parameter form the `--help` text advertises
(`model[effort=high,fast=true]`) is not how these ids are written. Get the real list
from `agent --list-models` — the Grok family is
`cursor-grok-4.6-{low,medium,high,xhigh}` with an optional `-fast` suffix. Never
downgrade for "cheap mechanical" work.

### Grok only — no foreign models, ever

**Cursor-W runs the newest Grok models exclusively.** No exceptions, no fallbacks, no
"just this once because the task is small/large/stuck".

- **Allowed:** the newest Grok family exposed by `agent --list-models`, i.e.
  `cursor-grok-4.6-*` (currently pinned: `cursor-grok-4.6-high-fast`). When a newer
  Grok generation ships, the pin moves forward to it — never sideways to another
  vendor.
- **Forbidden for every subagent in this skill:** any non-Grok model. That explicitly
  includes Anthropic (`claude-*`, Opus, Sonnet, Haiku, Fable), OpenAI (`gpt-*`, `o*`,
  Codex), Google (Gemini), and anything else `agent --list-models` may offer. Passing
  one is a hard error, not a preference: the runner fails the run rather than silently
  accepting it.
- **No silent downgrade either.** An older Grok generation, or a lower-effort slug
  picked to save money, counts as a violation of the pin just as much as a foreign
  model does.
- If the pinned model is unavailable, **stop and report it**. Do not substitute a
  different model to keep the wave moving — a wave run on the wrong model is not the
  work that was asked for.
- This applies to the workers only. The orchestrator is whatever session invoked the
  skill and is out of scope for this rule.

## Hard rules

1. **Self-contained prompts.** Subagents share no history with you or each other:
   absolute paths, what to read first, the exact task, acceptance criteria, output
   contract. (Exception: `resumeSessionId` continues a real session.)
2. **`force` or it did not happen** — runner-enforced. Anything that writes or runs
   a command needs `permissionMode: "force"`. Measured: without it, *edits still go
   through*, but **every shell command is rejected** — and the run still reports
   success. Any task with a proof command is therefore worthless without `force`.
3. **Read means read** — runner-enforced from the other side: `mode: "read"` may not
   run under `force`, because then nothing keeps it read-only.
4. **Writers must be disjoint.** Same-file writers must be sequenced with `after`.
5. **Grok only.** Every subagent runs the pinned newest Grok model. Never an
   Anthropic (Opus/Sonnet/Haiku), OpenAI (GPT/o-series) or any other foreign model,
   and never an older or lower-effort Grok slug. If the pin cannot be honoured, abort
   and say so.
6. **Schema for anything you parse**; act on `structuredOutput`, never on prose.
7. **Ask for the unguessable**, then check `toolCalls`.
8. **Never verify by asking the same kind of agent** — sole exception: a *blind*
   verifier that never saw the writer's claims. Run the proof command yourself regardless.
9. **Never let a subagent block.** End every prompt with: "if something is ambiguous,
   state it and pick the most conservative reading — you cannot ask questions."

## Protocol

Scope (goal + acceptance in 2–3 lines) → decompose (≤10 disjoint units; every
implementation unit gets a proof command that **fails loudly on an empty diff**) →
announce the wave (id, mode, one-line intent) → one runner call per wave (the runner
parallelizes — never fan out at your own tool level) → triage `_summary.json` →
verify substance yourself → integrate and report what you rejected and why.

For review-shaped jobs slice by **dimension** (correctness, performance, API contract,
test coverage), not by file, each with a schema.

Statuses: `ok` (still check `suspectNoToolCall` **and** `rejectedToolCalls`) · `schema-mismatch` (the answer did
not match the contract — read `schemaProblems`) · `skipped` (dependency not ok) ·
`unparsable` (no result event; treat as failed) · `failed` / `timeout` (read
`<id>.err.txt` and `<id>.stream.jsonl`).

## Running a wave

```bash
node <skill dir>/cursor-fan.mjs \
  --tasks-file wave1.json --out-dir wave1-out \
  --default-cwd /path/to/project --max-parallel 10
```

Options: `--permission-mode` (default `force`; the default for `read`/`plan` tasks is
derived from the mode) · `--timeout-sec` (default 1800 per task) · `--dry-run` (print
the exact command lines, spend nothing) · `--model` (accepts only the pinned value —
passing anything else fails) · `--strip-workspace-context` (see the task table) · env
`CURSOR_AGENT_ENTRY` overrides the binary auto-detection. Exit 1 if any task did not end `ok` — read `_summary.json` regardless.

## Task file — a JSON array of task objects

| field | |
|---|---|
| `id`, `prompt` | required; `id` filename-safe and unique; `prompt` fully self-contained |
| `mode` | `read` (default) / `plan` / `write` / `shell` / `full` — pick the narrowest that works |
| `cwd` | working dir; defaults to `--default-cwd` |
| `after`, `afterAny` | dependency id(s); `afterAny: true` runs even if the dependency failed (verifiers) |
| `schema` | JSON Schema → appended as an output contract, then parsed and checked on return |
| `timeoutSec` | per-task wall clock; defaults to `--timeout-sec` |
| `resumeSessionId`, `continueSession` | corrective rounds (`sessionId` from `_summary.json`) |
| `permissionMode` | `force` / `autoReview` / `readonly` / `plan` — writing modes must stay `force` |
| `stripWorkspaceContext` | strip the harness's own rules and skills from the subagent's context. **Opt-in and server-gated** — see below |
| `sandbox`, `systemPrompt`, `excludeTools`, `approveMcps` | pass-through overrides; see the caveats below |
| `model`, `effort`, `maxTurns` | **refused** — the first two are pinned to the newest Grok (no Anthropic/OpenAI/other vendor, no older or lower-effort Grok), the third does not exist in this CLI |

How a mode becomes flags: `read` → `--mode ask` · `plan` → `--plan` ·
`write`/`shell`/`full` → `--force`. Scope is enforced by permission mode, not by a
tool allowlist, because Cursor's `--allowed-tools` / `--exclude-tools` are marked
"internal only" and take protobuf field names — the same class of trap as a silently
ignored tool name. If you use `excludeTools`, verify the names took effect in the
event stream.

### Writer + blind verifier — the core pattern

```json
[
  { "id": "fix",        "mode": "full",  "permissionMode": "force", "cwd": "/repo",
    "prompt": "<frozen spec>" },
  { "id": "fix-verify", "mode": "shell", "permissionMode": "force", "cwd": "/repo",
    "after": "fix", "afterAny": true,
    "prompt": "Inspect the working tree of /repo and run: <proof command>. Judge only what you can observe. Report fail if the work is absent, incomplete, or the command does not pass.",
    "schema": { "type": "object", "required": ["verdict", "evidence"], "properties": {
      "verdict": { "type": "string", "enum": ["pass", "fail"] }, "evidence": { "type": "string" } } } }
]
```

The verifier prompt gets the acceptance criteria and the proof command — **never the
writer's report**. The runner never injects a dependency's output into a dependent
prompt, so blindness holds unless you paste it in yourself.

## Prompt template

```
CONTEXT      repo root; files in your slice (absolute paths); read these first
TASK         one precise instruction
ACCEPTANCE   how it is judged — include something unguessable
OUTPUT       exact shape, or "follow the output contract at the end of this message"
CONSTRAINTS  stay in your slice; do not run the full test suite; if something is
             ambiguous, state it and pick the most conservative reading — you
             cannot ask questions.
```

## Shape 3 — fanout pipeline (harness with a `Workflow` tool only)

```
Workflow({ scriptPath: '<skill dir>/cursor-fanout.js',
           args: { goal: '<what to build>', repo: '.', maxWorkers: 6, isolation: 'worktree' } })
```

args: `goal` (required) · `repo` ('.') · `maxWorkers` (6, cap 10) · `maxRounds` (2) ·
`isolation` (`worktree`; **`none` outside a git repo**) · `specReview` (true). No
argument selects the orchestrator or the worker model — thinking agents inherit the
calling session, the worker is pinned. `cursor-fanout.js` needs `RUNNER_DEFAULT` (or
`args.runner`) set to the absolute path of `cursor-fan.mjs`. Without a `Workflow`
tool, run the equivalent by hand: freeze specs, dispatch writer + blind-verifier
waves, review each diff yourself.

## Measured behaviour (Cursor CLI 2026.08.11-e8db854 / cursor-grok-4.6-high-fast)

Run live against a real account. Each of these silently breaks a naive integration:

1. **Without `--force`, edits execute but shell commands are rejected.** Five
   attempts, every one refused, and the process still exits 0 with
   `subtype: "success"` and `is_error: false`. The runner surfaces this as
   `rejectedToolCalls` and refuses writing modes without `force` in the first place.
2. **The subagent's `PATH` is not yours.** Cursor's bundled Node shadows the one on
   your shell's `PATH`: a subagent running `node --version` reported `v24.5.0` where
   the parent shell had `v24.12.0`. It had genuinely run the command — the answer was
   correct *for its environment*. **This looks exactly like fabrication if you do not
   check.** Pin the toolchain by absolute path in any proof command whose result
   depends on the version.
3. **Subagents inherit the harness's own rules and skills** as workspace context. One
   dispatch spent a read on `~/.claude/skills/cursor-w/SKILL.md` before starting its
   actual job — context you never put in the frozen spec.
4. **`--exclude-workspace-context` is server-gated.** On an account without the
   entitlement, *every* task dies: `[invalid_argument] Workspace context exclusion is
   not allowed for this user, team, or selected model`. Hence `stripWorkspaceContext`
   is opt-in — verify your account accepts it on one task before using it on a wave.
5. **`tool_call` events come in `started` / `completed` pairs.** The runner counts
   starts, so `toolCalls` is the number of real calls, not double.
6. **`--mode ask` genuinely reads files.** Asked for a random 20-character token and
   its line number, it returned both character-exact.
7. **Resume works headless and keeps context.** `resumeSessionId` continued a writer
   session that then extended the file it had created earlier — without being told the
   path again. Corrective rounds state only what is wrong.
8. **Effort and speed live in the model slug**, not in flags or bracket parameters:
   `cursor-grok-4.6-{low,medium,high,xhigh}[-fast]`, per `agent --list-models`.
9. **The flags that do not exist:** `--max-turns`, `--json-schema`, `--prompt-file`,
   `--deny`, `--no-subagents`. Hidden but real: `--allowed-tools`, `--exclude-tools`
   (both "internal only", taking protobuf field names), `--system-prompt`,
   `--single-turn`, `--new-session-id`.

**On fabrication:** across the live tasks run here — reads, writes, a blind verifier,
a corrective round — nothing was fabricated. Every claim matched disk. That is a small
sample on a different CLI than grok-w measured, so the doctrine stands as inherited,
not as re-confirmed: **keep verifying.** The one result that looked like fabrication
was finding 2, and it was the environment, not the model.

The runner's own machinery is additionally tested against a stub CLI that replays real
event streams: tool-call and rejection counting, the suspect flag, JSON extraction
(fenced and prose-wrapped), schema checking, the dependency scheduler including
`skipped` and `afterAny`, per-task timeouts with process-group kill, non-zero exits,
and every refusal path.

## Platform notes

- `agent --worktree` is for interactive isolation; headless isolation comes from
  Workflow worktrees or disjoint file partitioning.
- The runner spawns the CLI directly with an argument array and no shell. On Windows
  it **refuses** a `.cmd`/`.ps1` shim, because a shim re-parses arguments and would
  corrupt a multi-line prompt — point `CURSOR_AGENT_ENTRY` at the real executable.
- There is no `--prompt-file`, so the prompt travels as one argv entry. Keep bulk
  context in files the subagent reads; the runner refuses prompts over 120k chars.
- Source of truth: github.com/sauerlandtreffi/Cursor-Grok-Workflow. Ported from
  github.com/sauerlandtreffi/grok-w.
