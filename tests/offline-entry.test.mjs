import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { commandTokens, memoryRuntime, workerEnvironment } from '../lib/offline.js'
import { apply } from '../index.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fixchain offline '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime.json')
  const value = { schemaVersion: 'migloop.distillation-runtime/1', python: 'python3', skills: join(root, 'skills'), migloop: { directory: join(root, 'migloop') } }
  await writeFile(runtime, JSON.stringify(value))
  return { root, runtime, value }
}

test('quoted run paths preserve spaces and Windows backslashes', () => {
  assert.deepEqual(commandTokens(String.raw`cards "C:\offline runs\one" --resume`), ['cards', String.raw`C:\offline runs\one`, '--resume'])
  assert.deepEqual(commandTokens("cards '/tmp/offline runs/one'"), ['cards', '/tmp/offline runs/one'])
})

test('neutral minimal runtime requires no Studio or evaluation fields', async t => {
  const { runtime } = await fixture(t)
  const value = await memoryRuntime(runtime)
  assert.equal(value.pluginRoot, undefined)
  assert.equal(value.evaluation, undefined)
  assert.equal(value.dshCli, undefined)
  assert.deepEqual(workerEnvironment(runtime, { PATH: '/existing/tools', DSH_HOME: '/existing/dsh' }), {})
})

test('managed runtime can select its DSH home and bundled pnpm', async t => {
  const { root, runtime, value } = await fixture(t)
  value.dshCli = join(root, 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
  value.dshHome = join(root, 'selected profile')
  await writeFile(runtime, JSON.stringify(value))
  const env = workerEnvironment(runtime, { PATH: '/existing/tools' })
  assert.equal(env.DSH_HOME, value.dshHome)
  assert.equal(env.PATH, join(root, 'runtime/node_modules/.bin') + delimiter + '/existing/tools')
  value.dshCli = 'relative.js'
  await writeFile(runtime, JSON.stringify(value))
  assert.throws(() => workerEnvironment(runtime), /absolute/)
})

function command(config = {}) {
  let definition
  const disposers = []
  apply({
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    commands: { register(value) { definition = value; return () => {} } },
    inject() {},
  }, config)
  return { handler: definition.handler, dispose: () => disposers.reverse().forEach(dispose => dispose()) }
}

test('malformed quoted input returns a command error', async () => {
  const cmd = command()
  try {
    const result = await cmd.handler({ rawInput: 'cards "unterminated path' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Unterminated quoted argument/)
  } finally { cmd.dispose() }
})

test('minimal runtime launches an explicit local worker without dshCli', async t => {
  const { root, runtime } = await fixture(t)
  const cli = join(root, 'fake-worker.mjs')
  await writeFile(cli, "import {writeFileSync} from 'node:fs'; writeFileSync('worker-started.json', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n")
  await writeFile(join(root, 'job.json'), JSON.stringify({ worker_host: 'dsh', materials: root }))
  const cmd = command({ memoryRuntime: runtime, dshCommand: [process.execPath, cli], runsDir: root })
  try {
    const result = await cmd.handler({ rawInput: `cards "${root}"` })
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /启动/)
    const deadline = Date.now() + 5000
    let state
    while (Date.now() < deadline) {
      state = JSON.parse(await readFile(join(root, 'dsh-worker-state.json'), 'utf8'))
      if (state.endedAt) break
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.ok(state.endedAt, 'local fake worker did not finish')
    assert.equal(state.status, 'needs_attention', 'a fake worker with no delivery must not pass')
    const receipt = JSON.parse(await readFile(join(root, 'worker-started.json'), 'utf8'))
    assert.equal(receipt.cwd, await realpath(root))
    assert.ok(receipt.args.includes('--approval-policy'))
    assert.ok(receipt.args.includes('never'))
  } finally { cmd.dispose() }
})
