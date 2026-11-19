// dsh-fixchain: repair-chain attribution (返修链路归因 -> cards) for DeepSeek Harness migrations.
//
// /fixchain view <session> [<session> ...]   freeze the Sessions (sub-agents included) and serve the inquiry UI:
//                                            browse the trajectory as a file × agent time tree, no analysis run
// /fixchain stop                             stop viewers started by this plugin
// /fixchain prepare --migration <id> --repair <id> [--repair <id>] [--project DIR] [--source DIR] [--out DIR]
//                   [--base NAME | --base-store DIR --base-memory DIR] [--app NAME]
//                                            distill.py prepare --platform dsh: frozen material pools, git checkpoints,
//                                            evidence, start library, skills, job.json and CLAUDE.md
// /fixchain cards <run dir> [--resume]       run the card session inside dsh (a headless dsh Session in the run dir
//                                            follows migloop-session-to-memory), then distill.py check
// /fixchain status <run dir>                 worker state, completion and the last check
// /fixchain check <run dir>                  distill.py check alone
//
// All analysis is the a2h-memory toolchain as shipped (distill/distill.py, migloop/src/migloop/inquiry, the skills);
// this plugin finds Session logs through dsh's persistence service and starts processes.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { pythonCommand, runPython, startServer, stopServer } from './lib/python.js'
import { locateSession } from './lib/sessions.js'
import { prepareOffline, checkOffline, memoryRuntime, workerEnvironment, commandTokens } from './lib/offline.js'

export const name = 'dsh-fixchain'
export const inject = ['commands']

// Same text as distill/distill.py PROMPT / RESUME.
const PROMPT = '请读取当前目录 CLAUDE.md 和 job.json，按其中入口 skill 完成本任务。'
const RESUME = '这是同一任务的续跑；先读取已有产物及 last-feedback.json（若有），复用已完成工作。'

export const Config = Schema.object({
  memoryRuntime: Schema.string().default('').description('Standalone MigLoop runtime JSON; defaults to HMBOT_MEMORY_RUNTIME'),
  a2hMemory: Schema.string().default('').description('a2h-memory checkout with dsh support; empty: $A2H_MEMORY'),
  python: Schema.string().default('').description('Python 3.10+ with PyYAML; empty: DSH_FIXCHAIN_PYTHON, else `py -3` / `python3`'),
  pythonArgs: Schema.array(Schema.string()).default([]),
  runsDir: Schema.string().default('').description('Default parent of prepared runs; empty: $DSH_HOME/fixchain-runs'),
  dshCommand: Schema.array(Schema.string()).default([]).description('Command that starts dsh for the card worker; empty: this process\'s launcher'),
  workerProfile: Schema.string().default('headless').description('dsh profile of the card worker'),
  workerModel: Schema.string().default('deepseek-flash').description('Model label recorded as the analysis model'),
  viewHost: Schema.string().default('127.0.0.1'),
})

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settings(config) {
  const repo = config.a2hMemory || process.env.A2H_MEMORY || ''
  const runtime = config.memoryRuntime || process.env.HMBOT_MEMORY_RUNTIME || ''
  const rt = runtime ? readJson(runtime) : {}
  return {
    repo: repo ? resolve(repo) : '',
    runtime,
    python: config.python || rt.python ? { cmd: config.python || rt.python, args: [...(config.pythonArgs ?? [])] } : pythonCommand({}),
    runsDir: resolve(config.runsDir || join(dshHome(), 'fixchain-runs')),
    dsh: config.dshCommand?.length ? config.dshCommand : [process.execPath, rt.dshCli || process.argv[1]],
    workerProfile: config.workerProfile || 'headless',
    workerModel: config.workerModel || 'deepseek-flash',
    viewHost: config.viewHost || '127.0.0.1',
  }
}

function requireRepo(s) {
  if (!s.repo || !existsSync(join(s.repo, 'distill', 'distill.py'))) {
    throw new Error(`a2h-memory checkout not configured or invalid: "${s.repo}" (config a2hMemory or $A2H_MEMORY)`)
  }
}

/** `--key value` pairs (repeatable keys collect into arrays) plus bare positionals. */
function parseArgs(tokens) {
  const flags = {}
  const positional = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const value = tokens[i + 1] && !tokens[i + 1].startsWith('--') ? tokens[++i] : true
      flags[key] = key in flags ? [].concat(flags[key], value) : value
    } else positional.push(t)
  }
  return { flags, positional }
}

const list = v => (v === undefined ? [] : [].concat(v))
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))

async function view(ctx, s, viewers, tokens) {
  const rt = s.runtime ? await memoryRuntime(s.runtime) : null
  if (!rt) requireRepo(s)
  const { positional } = parseArgs(tokens)
  if (!positional.length) throw new Error('give at least one Session id (e.g. the migration and its repair)')
  const persistence = ctx.get('sessionPersistence')
  const found = []
  for (const wanted of positional) found.push(await locateSession(persistence, wanted))
  const key = found.map(f => f.id.replace(/^session-/, '').slice(0, 8)).join('-')
  const stamp = Date.now().toString(36)
  const work = join(s.runsDir, 'views', `${key}-${stamp}`)
  mkdirSync(work, { recursive: true })
  const env = { PYTHONPATH: rt ? join(rt.migloop.directory, 'src') : join(s.repo, 'migloop', 'src') }
  for (const f of found) {
    const out = join(work, 'pool', f.id.replace(/^session-/, '').slice(0, 8))
    const args = rt ? ['-c', 'import json,sys; from migloop.adapters.dsh_source import freeze_tree; print(json.dumps(freeze_tree(sys.argv[1],sys.argv[2],sys.argv[3])))', f.path, out, f.root] : ['-m', 'migloop.inquiry.source_adapters', f.path, '--out', out, '--sessions-root', f.root]
    const r = await runPython(s.python, args, { env })
    if (r.code !== 0) throw new Error(`freezing ${f.id} failed:\n${(r.stderr || r.stdout).slice(-1200)}`)
  }
  const db = join(work, 'index.sqlite')
  const imported = await runPython(s.python, ['-m', 'migloop.inquiry', '--db', db, 'import', '--pool', join(work, 'pool')], { env })
  if (imported.code !== 0) throw new Error(`indexing failed:\n${(imported.stderr || imported.stdout).slice(-1200)}`)
  const server = await startServer(s.python, ['-m', 'migloop.inquiry', '--db', db, 'serve', '--port', '0'],
    out => out.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1], { env })
  viewers.set(key, server.child)
  server.child.on('close', () => { if (viewers.get(key) === server.child) viewers.delete(key) })
  const stats = (() => { try { return JSON.parse(imported.stdout) } catch { return {} } })()
  return [`轨迹视图已启动（只浏览，不做归因；/fixchain stop 关闭）：${server.ready}`,
    `会话：${found.map(f => f.id).join(', ')}`,
    `索引：${stats.sources ?? '?'} 份会话，${stats.records ?? '?'} 条记录，${stats.effects ?? '?'} 个文件读写`,
    `材料：${join(work, 'pool')}`].join('\n')
}

function stopViewers(viewers) {
  const n = viewers.size
  for (const child of viewers.values()) stopServer(child)
  viewers.clear()
  return n ? `已停止 ${n} 个轨迹视图` : '没有由本插件启动的轨迹视图'
}

async function prepare(ctx, s, tokens) {
  const { flags } = parseArgs(tokens)
  if (flags.offline) {
    if (!flags.out) throw new Error('Offline prepare requires --offline <config.json> --out <new directory>')
    return JSON.stringify(await prepareOffline(resolve(String(flags.offline)), resolve(String(flags.out)), { runtime: s.runtime }))
  }
  if (!s.repo) throw new Error('Use /fixchain prepare --offline <config.json> --out <run>; standalone MigLoop requires no a2h-memory checkout')
  requireRepo(s)
  if (!flags.migration || !list(flags.repair).length) throw new Error('need --migration <id> and --repair <id>')
  const persistence = ctx.get('sessionPersistence')
  const migration = await locateSession(persistence, String(flags.migration))
  const repairs = []
  for (const r of list(flags.repair)) repairs.push(await locateSession(persistence, String(r)))
  const project = resolve(String(flags.project || migration.header.cwd || ''))
  const app = String(flags.app || project.split(/[\\/]/).pop() || 'app')
  const out = resolve(String(flags.out || join(s.runsDir, `${app}-${migration.id.replace(/^session-/, '').slice(0, 8)}-${Date.now().toString(36)}`)))
  const args = [join(s.repo, 'distill', 'distill.py'), 'prepare', '--platform', 'dsh', '--worker-host', 'dsh',
    '--project', project, '--source', resolve(String(flags.source || project)), '--out', out, '--app', app,
    '--generation-session', migration.id, ...repairs.flatMap(r => ['--repair-session', r.id]),
    '--dsh-sessions', migration.root]
  if (flags['generation-ref']) args.push('--generation-ref', String(flags['generation-ref']))
  if (flags.final) args.push('--final', String(flags.final))
  if (flags.base) args.push('--base', String(flags.base))
  if (flags['base-store']) args.push('--base-store', resolve(String(flags['base-store'])))
  if (flags['base-memory']) args.push('--base-memory', resolve(String(flags['base-memory'])))
  const r = await runPython(s.python, args, { timeoutMs: 900000 })
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
  if (r.code !== 0) throw new Error(`distill prepare failed:\n${(r.stderr || r.stdout).slice(-1500)}`)
  const result = JSON.parse(last)
  return [`已准备制卡 run：${result.prepared}`,
    `迁移会话 ${result.generation}，返修会话 ${result.repairs.join(', ')}`,
    `检查点 ${result.generation_checkpoint} → ${result.final_checkpoint}，起点库 ${result.start_revision}`,
    `边界：生成结束 ${result.boundary.generation_end}；返修交接 ${result.boundary.repair_handoff}；最终提交回执 ${result.boundary.final_commit_receipt}`,
    `下一步：/fixchain cards ${result.prepared}`].join('\n')
}

function workerState(run) {
  const p = join(run, 'dsh-worker-state.json')
  return existsSync(p) ? readJson(p) : { attempts: 0, status: 'prepared' }
}

async function check(s, run) {
  if (s.runtime) return checkOffline(run, { runtime: s.runtime })
  const r = await runPython(s.python, [join(s.repo, 'distill', 'distill.py'), 'check', '--run', run], { timeoutMs: 900000 })
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '{}'
  try { return JSON.parse(last) } catch { return { ok: false, error: (r.stderr || r.stdout).slice(-800) } }
}

function cards(s, workers, tokens) {
  if (!s.runtime) requireRepo(s)
  const { flags, positional } = parseArgs(tokens)
  const run = resolve(positional[0] || '')
  if (!existsSync(join(run, 'job.json'))) throw new Error(`not a prepared run directory: ${run}`)
  const job = readJson(join(run, 'job.json'))
  if (job.worker_host !== 'dsh') throw new Error('this run was not prepared for a dsh worker (/fixchain prepare does that)')
  if (workers.get(run)?.exitCode === null) return `制卡会话仍在运行：${run}`
  if (process.platform === 'win32') {
    // build_bundle stages skills in a tempfile directory; on Windows Python gives such directories an owner-only
    // protected ACL, which the dsh Windows sandbox token cannot read. Let skills/ inherit the run directory's ACL.
    const reset = spawnSync('icacls', [join(run, 'skills'), '/reset', '/T', '/C', '/Q'], { windowsHide: true, encoding: 'utf8' })
    if (reset.status !== 0) throw new Error(`could not make skills/ readable for the dsh sandbox: ${reset.stdout}${reset.stderr}`)
  }
  const state = workerState(run)
  const resume = Boolean(flags.resume) && state.sessionId
  state.attempts += 1
  const n = state.attempts
  const context = join(run, 'analysis-runtime.json')
  const previous = existsSync(context) ? readJson(context) : null
  writeFileSync(context, JSON.stringify({ schema: 'migloop-analysis-runtime/1', materials: resolve(job.materials),
    analysis: { platforms: ['dsh'], models: [s.workerModel], root_session_ids: previous?.analysis?.root_session_ids ?? [] } }, null, 1))
  const args = [...s.dsh.slice(1), '--profile', s.workerProfile, '--json', '--approval-policy', 'never',
    ...(resume ? ['--session-id', state.sessionId] : []), resume ? `${PROMPT}${RESUME}` : PROMPT]
  const child = spawn(s.dsh[0], args, { cwd: run, windowsHide: true,
    env: { ...process.env, ...(s.runtime ? workerEnvironment(s.runtime) : {}), MIGLOOP_ANALYSIS_CONTEXT: context, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } })
  workers.set(run, child)
  const events = createWriteStream(join(run, `dsh-worker-${n}.jsonl`))
  const stderr = createWriteStream(join(run, `dsh-worker-${n}.stderr.log`))
  let buffer = ''
  child.stdout.on('data', (d) => {
    events.write(d)
    buffer += d
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'session' && ev.sessionId) {
          state.sessionId = ev.sessionId
          const ctxFile = readJson(context)
          ctxFile.analysis.root_session_ids = [...new Set([...ctxFile.analysis.root_session_ids, ev.sessionId])]
          writeFileSync(context, JSON.stringify(ctxFile, null, 1))
          writeFileSync(join(run, 'dsh-worker-state.json'), JSON.stringify(state, null, 1))
        }
      } catch { /* not a JSON event line */ }
    }
  })
  child.stderr.pipe(stderr)
  Object.assign(state, { status: 'running', startedAt: new Date().toISOString(), profile: s.workerProfile })
  writeFileSync(join(run, 'dsh-worker-state.json'), JSON.stringify(state, null, 1))
  child.on('close', async (code) => {
    events.end()
    stderr.end()
    const delivered = await check(s, run).catch(error => ({ ok: false, error: String(error) }))
    Object.assign(state, { status: delivered.ok ? 'completed' : 'needs_attention', exitCode: code,
      endedAt: new Date().toISOString(), check: delivered })
    if (!delivered.ok) writeFileSync(join(run, 'last-feedback.json'), JSON.stringify({ error: delivered.error, at: state.endedAt }, null, 1))
    writeFileSync(join(run, 'dsh-worker-state.json'), JSON.stringify(state, null, 1))
  })
  return [`制卡会话已在 dsh 里启动（第 ${n} 次${resume ? '，续跑' : ''}，profile ${s.workerProfile}）：${run}`,
    `事件流：dsh-worker-${n}.jsonl；结束后自动跑 distill.py check。进度：/fixchain status ${run}`].join('\n')
}

function status(workers, tokens) {
  const run = resolve(tokens[0] || '')
  if (!existsSync(join(run, 'job.json'))) throw new Error(`not a prepared run directory: ${run}`)
  const state = workerState(run)
  const lines = [`run ${run}`, `状态 ${state.status}${workers.get(run)?.exitCode === null ? '（运行中）' : ''}，第 ${state.attempts} 次，会话 ${state.sessionId ?? '-'}`]
  if (existsSync(join(run, 'completion.json'))) {
    const c = readJson(join(run, 'completion.json'))
    lines.push(`completion：${c.status} · 卡 ${(c.cards ?? []).length} 张 · ${String(c.reason ?? '').slice(0, 200)}`)
  }
  if (state.check) lines.push(`check：${state.check.ok ? '通过' : '未通过'} ${state.check.ok ? `revision ${state.check.revision}` : String(state.check.error ?? '').slice(0, 300)}`)
  return lines.join('\n')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const s = settings(config)
  const viewers = new Map()
  const workers = new Map()
  ctx.effect(() => () => {
    for (const child of viewers.values()) stopServer(child)
    for (const child of workers.values()) stopServer(child)
    viewers.clear()
    workers.clear()
  }, 'dsh-fixchain: processes')

  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-fixchain/fixchain',
    name: 'fixchain',
    description: 'Repair-chain attribution: view | prepare | cards | status | check | stop',
    input: { hint: 'view <session…> | prepare --migration <id> --repair <id> | cards <run> | status <run>' },
    handler: async (invocation) => {
      try {
        const tokens = commandTokens(invocation.rawInput)
        const verb = tokens.shift() ?? 'help'
        let text
        if (verb === 'view') text = await view(ctx, s, viewers, tokens)
        else if (verb === 'stop') text = stopViewers(viewers)
        else if (verb === 'prepare') text = await prepare(ctx, s, tokens)
        else if (verb === 'cards') text = cards(s, workers, tokens)
        else if (verb === 'status') text = status(workers, tokens)
        else if (verb === 'check') {
          if (!s.runtime) requireRepo(s)
          const r = await check(s, resolve(tokens[0] || ''))
          text = r.ok ? `交付检查通过：${r.card_count} 张卡，revision ${r.revision}` : `交付检查未通过：${r.error}`
        } else {
          text = '/fixchain prepare --offline <config.json> --out <run>：原生离线材料制备（无需 a2h-memory）；prepare --migration <id> --repair <id>：原有在线流程；cards <run>：独立子代理制卡归并；check <run>；status <run>；view <会话…>；stop'
        }
        return { kind: 'success', text }
      } catch (error) {
        return { kind: 'error', text: `fixchain: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'dsh-fixchain: /fixchain')

  ctx.inject(['tools'], scope => {
    scope.effect(() => scope.get('tools').register({
      name: 'memory_distill', description: 'Standalone MigLoop Memory material preparation and strict delivery check. prepare takes an explicit native-format offline config and a new output; check requires completed independent cards and a revision-bound reading pack. No a2h-memory checkout.',
      parameters: { type: 'object', properties: { action: { enum: ['prepare', 'check'] }, config: { type: 'string' }, output: { type: 'string' }, run: { type: 'string' } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: (args, exec) => args.action === 'prepare' ? prepareOffline(args.config, args.output, { runtime: s.runtime, signal: exec?.signal }) : checkOffline(args.run, { runtime: s.runtime, signal: exec?.signal }),
    }))
  })
}
