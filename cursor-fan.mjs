#!/usr/bin/env node
// ============================================================================
// cursor-fan.mjs — Cursor-W dispatch runner. Port of grok-w's grok-fan.mjs to
// the Cursor Agent CLI (`agent` / `cursor-agent`).
//
// Runs a dependency-ordered JSON array of Cursor Agent tasks in parallel and
// writes one distilled result file per task, the raw event stream, and
// _summary.json. Doctrine and the task-file contract: see SKILL.md.
// The model is pinned (grok-4.6 at high effort, fast); per-task overrides are
// refused, and writing modes are refused unless the permission mode is 'force'.
//
// Usage:
//   node cursor-fan.mjs --tasks-file wave.json --out-dir wave-out \
//        [--default-cwd DIR] [--max-parallel 10] [--permission-mode force] \
//        [--timeout-sec 1800] [--dry-run]
// Env CURSOR_AGENT_ENTRY overrides the agent-binary auto-detection.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WIN = process.platform === 'win32'

// Standing instruction: Grok 4.6 at high effort, fast. Cursor bakes effort and speed
// into the model slug itself rather than exposing them as flags; the exact ids come
// from `agent --list-models` (cursor-grok-4.6-{low,medium,high,xhigh}[-fast]).
const MODEL = 'cursor-grok-4.6-high-fast'

// ---- CLI ------------------------------------------------------------------
const opts = {
  tasksFile: null, outDir: null, defaultCwd: process.cwd(),
  maxParallel: 10, model: MODEL,
  permissionMode: 'force', timeoutSec: 1800, dryRun: false,
  stripWorkspaceContext: false,
}
{
  const argv = process.argv.slice(2)
  const take = (i) => { if (i + 1 >= argv.length) fail(`missing value for ${argv[i]}`); return argv[i + 1] }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tasks-file': opts.tasksFile = take(i); i++; break
      case '--out-dir': opts.outDir = take(i); i++; break
      case '--default-cwd': opts.defaultCwd = take(i); i++; break
      case '--max-parallel': opts.maxParallel = parseInt(take(i), 10); i++; break
      case '--model': opts.model = take(i); i++; break
      case '--permission-mode': opts.permissionMode = take(i); i++; break
      case '--timeout-sec': opts.timeoutSec = parseInt(take(i), 10); i++; break
      case '--dry-run': opts.dryRun = true; break
      case '--strip-workspace-context': opts.stripWorkspaceContext = true; break
      default: fail(`unknown option: ${argv[i]}`)
    }
  }
}
function fail(msg) { console.error(`cursor-fan: ${msg}`); process.exit(2) }

// Accepting only the pinned value makes a wrong call a loud failure, not a
// silent downgrade to whatever the account's default model happens to be.
if (opts.model !== MODEL) fail(`--model accepts only '${MODEL}' (got '${opts.model}'). Cursor-W runs that model exclusively.`)
const PERM_MODES = ['force', 'autoReview', 'readonly', 'plan']
if (!PERM_MODES.includes(opts.permissionMode)) {
  fail(`--permission-mode must be ${PERM_MODES.join('|')} (got '${opts.permissionMode}').`)
}
if (!opts.tasksFile) fail('--tasks-file is required.')
if (!(opts.maxParallel >= 1 && opts.maxParallel <= 10)) fail('--max-parallel must be 1..10.')

// ---- locate the Cursor Agent entrypoint -----------------------------------
// Spawned with an args array and no shell, so nothing re-parses the prompt.
function resolveAgentEntry() {
  const candidates = []
  if (process.env.CURSOR_AGENT_ENTRY) candidates.push(process.env.CURSOR_AGENT_ENTRY)
  const names = WIN ? ['cursor-agent.exe', 'agent.exe', 'cursor-agent.cmd', 'agent.cmd'] : ['agent', 'cursor-agent']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = path.join(dir, n)
      if (existsSync(p)) {
        try { candidates.push(realpathSync(p)) } catch { candidates.push(p) }
      }
    }
  }
  // The installer's own layout, in case ~/.local/bin is not on PATH.
  const versDir = path.join(os.homedir(), '.local', 'share', 'cursor-agent', 'versions')
  if (existsSync(versDir)) {
    try {
      for (const v of readdirSync(versDir).sort().reverse()) {
        const p = path.join(versDir, v, WIN ? 'cursor-agent.exe' : 'cursor-agent')
        if (existsSync(p)) candidates.push(p)
      }
    } catch { /* unreadable — the other candidates must do */ }
  }
  for (const c of candidates) if (c && existsSync(c)) return c
  fail("could not locate the Cursor Agent CLI. Install it (curl https://cursor.com/install -fsS | bash) or set CURSOR_AGENT_ENTRY.")
}
const agentEntry = resolveAgentEntry()
// A Windows .cmd/.ps1 shim re-parses its arguments and would destroy a
// multi-line prompt. Refuse rather than silently mangle the task.
if (WIN && /\.(cmd|ps1|bat)$/i.test(agentEntry)) {
  fail(`resolved a Windows shim (${agentEntry}). It re-quotes arguments and would corrupt multi-line prompts. Point CURSOR_AGENT_ENTRY at the real executable.`)
}

// ---- modes ----------------------------------------------------------------
// Cursor has no verified per-tool allowlist (--allowed-tools/--exclude-tools are
// marked "internal only" and take protobuf oneof names), so scope is enforced by
// permission mode, not by a tool profile: read-only work runs in a read-only mode,
// and anything that must actually touch the disk runs under --force.
const MODES = ['read', 'plan', 'write', 'shell', 'full']
const WRITING_MODES = ['write', 'shell', 'full']
const defaultPermFor = (mode) => mode === 'read' ? 'readonly' : mode === 'plan' ? 'plan' : opts.permissionMode

// ---- load and validate tasks ----------------------------------------------
if (!existsSync(opts.tasksFile)) fail(`tasks file not found: ${opts.tasksFile}`)
let tasks
// Strip a UTF-8 BOM: task files written by Windows tools routinely carry one.
try { tasks = JSON.parse(readFileSync(opts.tasksFile, 'utf8').replace(/^﻿/, '')) } catch (e) { fail(`tasks file is not valid JSON: ${e.message}`) }
if (!Array.isArray(tasks)) tasks = [tasks]
if (tasks.length === 0) fail(`tasks file contains no tasks: ${opts.tasksFile}`)

const seen = new Set()
for (const t of tasks) {
  if (typeof t.id !== 'string' || !t.id.trim()) fail("every task needs a string 'id'. The tasks file must be a JSON array of task objects.")
  if (typeof t.prompt !== 'string' || !t.prompt.trim()) fail(`task '${t.id}' has no string 'prompt'.`)
  if (/[\\/:*?"<>|]/.test(t.id)) fail(`task id '${t.id}' contains characters that are illegal in filenames.`)
  if (seen.has(t.id)) fail(`duplicate task id: ${t.id}`)
  // Refuse instead of ignore: a silently dropped field is exactly the class of
  // failure this runner exists to prevent.
  if (t.model != null) fail(`task '${t.id}': per-task 'model' is not allowed. Cursor-W runs ${MODEL} exclusively; remove the field.`)
  if (t.effort != null) fail(`task '${t.id}': per-task 'effort' is not allowed. Effort is baked into the pinned model id (${MODEL}); remove the field.`)
  if (t.maxTurns != null) fail(`task '${t.id}': 'maxTurns' has no equivalent in the Cursor CLI — there is no --max-turns flag. Bound the task with 'timeoutSec'/--timeout-sec and a narrower slice instead; remove the field.`)
  seen.add(t.id)
}

const afterOf = (t) => (t.after == null ? [] : (Array.isArray(t.after) ? t.after : [t.after])).filter(Boolean).map(String)
for (const t of tasks) {
  for (const d of afterOf(t)) {
    if (!seen.has(d)) fail(`task '${t.id}': 'after' names unknown task '${d}'.`)
    if (d === t.id) fail(`task '${t.id}': 'after' cannot reference itself.`)
  }
}
// Kahn's algorithm — a cycle would deadlock the scheduler, so reject it up front.
{
  const indeg = new Map(tasks.map(t => [t.id, afterOf(t).length]))
  const queue = tasks.filter(t => indeg.get(t.id) === 0).map(t => t.id)
  let sorted = 0
  while (queue.length) {
    const k = queue.shift(); sorted++
    for (const t of tasks) {
      if (afterOf(t).includes(k) && indeg.set(t.id, indeg.get(t.id) - 1).get(t.id) === 0) queue.push(t.id)
    }
  }
  if (sorted !== tasks.length) fail("the 'after' fields form a cycle. Fix the task file.")
}

if (!opts.outDir) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  opts.outDir = path.join(WIN ? (process.env.TEMP || '.') : '/tmp', 'cursor-w', stamp)
}
mkdirSync(opts.outDir, { recursive: true })
const promptDir = path.join(opts.outDir, '_prompts')
mkdirSync(promptDir, { recursive: true })

// ---- the schema contract --------------------------------------------------
// Cursor has no --json-schema. Structured output is therefore a prompt contract
// the runner appends and then enforces on the way back: the result is parsed,
// shallow-validated against the schema's top level, and a miss is a loud status,
// never a quietly half-parsed object.
function schemaBlock(schema) {
  return [
    '',
    'OUTPUT CONTRACT — MANDATORY, THIS OVERRIDES ANY OTHER OUTPUT INSTRUCTION',
    '  Your FINAL message must be exactly one fenced JSON code block and nothing else:',
    '  no preamble, no explanation, no summary before or after it.',
    '',
    '  ```json',
    '  { ... }',
    '  ```',
    '',
    '  The object inside must validate against this JSON Schema:',
    JSON.stringify(schema, null, 2).split('\n').map(l => '  ' + l).join('\n'),
    '',
    '  Emit no other fenced json block in your final message.',
  ].join('\n')
}

// Walk the text for the last balanced {...} or [...] run, so a model that wrapped
// its answer in prose still yields the payload rather than a parse failure.
function balancedCandidates(text) {
  const out = []
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== open) continue
      let depth = 0, inStr = false, esc = false
      for (let j = i; j < text.length; j++) {
        const c = text[j]
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (c === open) depth++
        else if (c === close && --depth === 0) { out.push(text.slice(i, j + 1)); i = j; break }
      }
    }
  }
  return out.reverse()
}

function extractJson(text) {
  if (!text) return null
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map(m => m[1]).reverse()
  for (const c of [...fenced, ...balancedCandidates(text)]) {
    try { return JSON.parse(c.trim()) } catch { /* next candidate */ }
  }
  return null
}

// Deliberately shallow: this checks that the shape you are about to act on is
// the shape you asked for. It is not a JSON Schema implementation, and it does
// not pretend to be one — deep validation is the orchestrator's job.
function checkSchema(value, schema) {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type && schema.type !== kind) problems.push(`top level is ${kind}, schema says ${schema.type}`)
  for (const key of schema.required || []) {
    if (kind !== 'object' || !(key in value)) problems.push(`missing required key '${key}'`)
  }
  return problems
}

// ---- build invocations ----------------------------------------------------
const plan = []
for (const t of tasks) {
  const mode = t.mode ? String(t.mode) : 'read'
  if (!MODES.includes(mode)) fail(`task '${t.id}': unknown mode '${mode}' (use ${MODES.join('|')}).`)
  const cwd = t.cwd ? String(t.cwd) : opts.defaultCwd
  if (!existsSync(cwd)) fail(`task '${t.id}': cwd does not exist: ${cwd}`)
  const permMode = t.permissionMode ? String(t.permissionMode) : defaultPermFor(mode)
  if (!PERM_MODES.includes(permMode)) fail(`task '${t.id}': permissionMode must be ${PERM_MODES.join('|')} (got '${permMode}').`)

  // Fail loudly instead of dispatching a task that reports success and changes nothing.
  if (WRITING_MODES.includes(mode) && permMode !== 'force') {
    fail(`task '${t.id}': mode '${mode}' needs permissionMode 'force' (got '${permMode}'). ` +
      `Without --force the agent must ask before it writes or runs a command, and headless there is ` +
      `nobody to ask — the task ends without touching the disk while still reporting an answer. ` +
      `Set permissionMode 'force' on the task, or run the wave with --permission-mode force.`)
  }
  // The mirror image: a 'read' task under --force has nothing stopping it from
  // editing files, and read-only is the whole reason to declare mode 'read'.
  if (mode === 'read' && permMode === 'force') {
    fail(`task '${t.id}': mode 'read' must not run under permissionMode 'force' — nothing would keep it read-only. ` +
      `Use mode 'shell'/'full' if the task genuinely needs to act, or leave the permission mode at 'readonly'.`)
  }

  const prompt = t.schema ? String(t.prompt) + '\n' + schemaBlock(t.schema) : String(t.prompt)
  // Passed as a single argv entry, so it must not be read as an option.
  if (prompt.trimStart().startsWith('-')) fail(`task '${t.id}': prompt must not start with '-' — it is passed as a positional argument.`)
  if (prompt.length > 120000) fail(`task '${t.id}': prompt is ${prompt.length} chars. The Cursor CLI has no --prompt-file, so the prompt travels as one argument; keep it well under the OS argument limit by putting bulk context in files the subagent reads.`)
  const promptPath = path.join(promptDir, `${t.id}.txt`)
  writeFileSync(promptPath, prompt, 'utf8')

  const args = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', cwd, '--model', opts.model]
  if (permMode === 'force') args.push('--force')
  else if (permMode === 'autoReview') args.push('--auto-review')
  else if (permMode === 'readonly') args.push('--mode', 'ask')
  else if (permMode === 'plan') args.push('--plan')
  // Measured: a subagent loads the harness's own rules and skills as workspace context —
  // one dispatch here spent a read on ~/.claude/skills/cursor-w/SKILL.md before doing its
  // actual job. Stripping that would suit a frozen spec, but --exclude-workspace-context is
  // SERVER-GATED: on an account without the entitlement every task dies with
  // "[invalid_argument] Workspace context exclusion is not allowed for this user, team, or
  // selected model". So it is opt-in, and you must confirm your account accepts it.
  const strip = t.stripWorkspaceContext != null ? !!t.stripWorkspaceContext : opts.stripWorkspaceContext
  if (strip) args.push('--exclude-workspace-context')
  if (t.sandbox) args.push('--sandbox', String(t.sandbox))
  if (t.systemPrompt) args.push('--system-prompt', String(t.systemPrompt))
  if (t.excludeTools) args.push('--exclude-tools', String(t.excludeTools))
  if (t.approveMcps) args.push('--approve-mcps')
  // Resume selects the session the turn runs in.
  if (t.resumeSessionId) args.push('--resume', String(t.resumeSessionId))
  else if (t.continueSession) args.push('--continue')
  args.push(prompt)

  plan.push({
    id: t.id, mode, cwd, permMode, strippedWorkspaceContext: strip, after: afterOf(t), afterAny: !!t.afterAny,
    schema: t.schema || null, timeoutSec: t.timeoutSec ? parseInt(t.timeoutSec, 10) : opts.timeoutSec, args,
    outFile: path.join(opts.outDir, `${t.id}.json`),
    streamFile: path.join(opts.outDir, `${t.id}.stream.jsonl`),
    errFile: path.join(opts.outDir, `${t.id}.err.txt`),
  })
}

if (opts.dryRun) {
  for (const p of plan) {
    const dep = p.after.length ? ` after=${p.after.join(',')}` : ''
    const disp = p.args.map(a => /[\s"']/.test(a) ? `'${a.replace(/'/g, WIN ? "'" : "'\\''")}'` : a).join(' ')
    console.log(`[${p.id}]${dep} ${agentEntry} ${disp}`)
  }
  process.exit(0)
}

// ---- run with a concurrency throttle, honouring dependencies --------------
console.log(`cursor-w: ${plan.length} task(s), max ${opts.maxParallel} parallel, model=${opts.model} perm=${opts.permissionMode}`)
console.log(`cursor-w: results -> ${opts.outDir}`)

const results = {}
const startedAt = Date.now()

function killTree(proc) {
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-proc.pid, 'SIGKILL') // detached => own process group
  } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
}

// The fabrication tell. grok-w measured it as numTurns == 1, a proxy for "never
// called a tool"; the Cursor stream reports tool calls as events, so this counts
// the thing itself. A task that had to look at the world and never did answered
// from prior knowledge.
function digest(streamText) {
  const events = []
  for (const line of streamText.split('\n')) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    try { events.push(JSON.parse(s)) } catch { /* partial or non-JSON line */ }
  }
  const toolEvents = events.filter(e => e && e.type === 'tool_call')
  // Cursor emits a tool_call event per lifecycle stage; count starts only, and
  // fall back to raw count if this build does not use subtypes.
  const started = toolEvents.filter(e => e.subtype === 'started')
  const toolCalls = started.length || toolEvents.length
  // The second tell, and the one the inherited doctrine misses. Measured: a shell
  // command without --force comes back `rejected` — five times over — while the
  // process still exits 0 with subtype "success" and is_error false. The task made
  // plenty of tool calls, so the zero-tool-call flag never fires, and nothing in the
  // machine-readable result says the work was blocked. The stream does.
  const rejected = toolEvents.filter(e => {
    if (e.subtype !== 'completed' || !e.tool_call) return false
    const inner = e.tool_call[Object.keys(e.tool_call)[0]]
    return !!(inner && inner.result && inner.result.rejected)
  })
  const rejectedToolCalls = rejected.length
  const rejectedToolNames = [...new Set(rejected.map(e => Object.keys(e.tool_call)[0]))]
  const names = [...new Set(toolEvents.map(e => {
    if (typeof e.name === 'string') return e.name
    if (e.tool_call && typeof e.tool_call === 'object') return Object.keys(e.tool_call)[0]
    return e.subtype || 'unknown'
  }).filter(Boolean))]
  const result = [...events].reverse().find(e => e && e.type === 'result') || null
  const assistantTurns = events.filter(e => e && e.type === 'assistant').length
  return { events, toolCalls, toolNames: names, rejectedToolCalls, rejectedToolNames, result, assistantTurns, eventCount: events.length }
}

function runTask(item) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const proc = spawn(agentEntry, item.args, {
      cwd: item.cwd, stdio: ['ignore', 'pipe', 'pipe'],
      detached: !WIN, windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = '', stderr = '', timedOut = false
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      console.warn(`  !! timeout [${item.id}] after ${item.timeoutSec}s`)
      killTree(proc)
    }, item.timeoutSec * 1000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      const secs = Math.round((Date.now() - t0) / 100) / 10
      writeFileSync(item.streamFile, stdout, 'utf8')
      if (stderr) writeFileSync(item.errFile, stderr, 'utf8')

      // Digest regardless of exit code: a run that ends badly still tells you
      // what it did before it ended, and that is the evidence you triage on.
      const d = digest(stdout)
      const text = d.result && typeof d.result.result === 'string' ? d.result.result : ''
      const isError = d.result ? d.result.is_error === true : false

      let structured = null, schemaProblems = []
      if (item.schema) {
        structured = extractJson(text)
        schemaProblems = structured == null ? ['no JSON object found in the final message'] : checkSchema(structured, item.schema)
      }

      const status = timedOut ? 'timeout'
        : code !== 0 ? 'failed'
        : !d.result ? 'unparsable'
        : isError ? 'failed'
        : item.schema && schemaProblems.length ? 'schema-mismatch'
        : 'ok'
      const suspect = (status === 'ok' || status === 'schema-mismatch') && d.toolCalls === 0

      const record = {
        id: item.id, status, exitCode: code, seconds: secs,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        strippedWorkspaceContext: item.strippedWorkspaceContext,
        subtype: d.result ? d.result.subtype ?? null : null,
        isError, toolCalls: d.toolCalls, toolNames: d.toolNames,
        rejectedToolCalls: d.rejectedToolCalls, rejectedToolNames: d.rejectedToolNames,
        assistantTurns: d.assistantTurns, eventCount: d.eventCount,
        suspectNoToolCall: suspect,
        sessionId: d.result ? d.result.session_id ?? null : null,
        requestId: d.result ? d.result.request_id ?? null : null,
        usage: d.result ? d.result.usage ?? null : null,
        durationMs: d.result ? d.result.duration_ms ?? null : null,
        schemaProblems: item.schema ? schemaProblems : null,
        streamFile: item.streamFile, outputFile: item.outFile,
        errorFile: stderr ? item.errFile : null,
        after: item.after,
      }
      results[item.id] = record
      // The distilled per-task file: the final message and, when a schema was
      // asked for, the parsed object. structuredOutput is the only field to act on.
      writeFileSync(item.outFile, JSON.stringify({ ...record, result: text, structuredOutput: structured }, null, 2), 'utf8')

      const marker = status === 'ok' ? (suspect || d.rejectedToolCalls ? 'OK? ' : 'OK  ') : 'FAIL'
      const rej = d.rejectedToolCalls ? ` rejected=${d.rejectedToolCalls}` : ''
      console.log(`  <- ${marker} [${item.id}] exit=${code} tools=${d.toolCalls}${rej} ${secs}s${status !== 'ok' ? ` status=${status}` : ''}`)
      resolve()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      results[item.id] = {
        id: item.id, status: 'failed', exitCode: null, seconds: 0,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        subtype: `spawn error: ${err.message}`, isError: true, toolCalls: 0, toolNames: [],
        rejectedToolCalls: 0, rejectedToolNames: [],
        assistantTurns: 0, eventCount: 0, suspectNoToolCall: false,
        sessionId: null, requestId: null, usage: null, durationMs: null,
        schemaProblems: null, streamFile: null, outputFile: null, errorFile: null,
        after: item.after,
      }
      console.log(`  <- FAIL [${item.id}] spawn error: ${err.message}`)
      resolve()
    })
  })
}

let pending = [...plan]
const running = new Map()
while (pending.length > 0 || running.size > 0) {
  let progress = false
  const still = []
  for (const item of pending) {
    const unmet = item.after.find(d => !(d in results))
    const deadDep = unmet ? null : (item.afterAny ? null : item.after.find(d => results[d].status !== 'ok'))
    if (deadDep) {
      // Never verify a writer that never ran — the verdict would be meaningless.
      results[item.id] = {
        id: item.id, status: 'skipped', exitCode: null, seconds: 0,
        mode: item.mode, permissionMode: item.permMode, cwd: item.cwd,
        subtype: `dependency '${deadDep}' ended ${results[deadDep].status}`, isError: false,
        toolCalls: 0, toolNames: [], rejectedToolCalls: 0, rejectedToolNames: [],
        assistantTurns: 0, eventCount: 0,
        suspectNoToolCall: false, sessionId: null, requestId: null, usage: null,
        durationMs: null, schemaProblems: null, streamFile: null, outputFile: null,
        errorFile: null, after: item.after,
      }
      console.log(`  -- SKIP  [${item.id}] dependency '${deadDep}' ended ${results[deadDep].status}`)
      progress = true
    } else if (!unmet && running.size < opts.maxParallel) {
      const dep = item.after.length ? ` after=${item.after.join(',')}` : ''
      console.log(`  -> start [${item.id}] (${item.mode}/${item.permMode})${dep}`)
      running.set(item.id, runTask(item).then(() => running.delete(item.id)))
      progress = true
    } else {
      still.push(item)
    }
  }
  pending = still
  if (running.size > 0) await Promise.race(running.values())
  else if (pending.length > 0 && !progress) fail(`scheduler stalled with ${pending.length} task(s) pending and nothing running. Check the 'after' fields.`)
}

const summary = {
  outDir: opts.outDir, model: opts.model,
  permissionMode: opts.permissionMode, maxParallel: opts.maxParallel,
  totalSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  ok: Object.values(results).filter(r => r.status === 'ok').length,
  failed: Object.values(results).filter(r => r.status !== 'ok').length,
  suspect: Object.values(results).filter(r => r.suspectNoToolCall).length,
  rejected: Object.values(results).filter(r => r.rejectedToolCalls > 0).length,
  tasks: plan.map(p => results[p.id]),
}
const summaryPath = path.join(opts.outDir, '_summary.json')
writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')

console.log('')
console.log(`cursor-w: done in ${summary.totalSeconds}s -- ${summary.ok} ok, ${summary.failed} failed, ${summary.suspect} suspect, ${summary.rejected} with rejected tool calls`)
console.log(`cursor-w: summary -> ${summaryPath}`)
for (const r of summary.tasks) {
  if (r.status === 'schema-mismatch') console.log(`cursor-w: NEEDS ATTENTION [${r.id}] status=schema-mismatch -- ${(r.schemaProblems || []).join('; ')}`)
  else if (r.status !== 'ok') console.log(`cursor-w: NEEDS ATTENTION [${r.id}] status=${r.status} subtype=${r.subtype}`)
  if (r.suspectNoToolCall) console.log(`cursor-w: SUSPECT [${r.id}] toolCalls=0 -- it never looked at anything; treat the answer as fabricated until you verify it yourself`)
  if (r.rejectedToolCalls > 0) console.log(`cursor-w: BLOCKED [${r.id}] ${r.rejectedToolCalls} tool call(s) rejected (${r.rejectedToolNames.join(', ')}) -- the environment refused the work; the task's answer describes something that never ran`)
}
process.exitCode = summary.failed > 0 ? 1 : 0
