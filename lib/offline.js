import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPython } from './python.js'

export async function memoryRuntime(path = process.env.HMBOT_MEMORY_RUNTIME) {
  if (!isAbsolute(path || '')) throw new Error('Provide an absolute standalone MigLoop runtime JSON path')
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (!['migloop.distillation-runtime/1', 'hmbot.memory.runtime/1', 'hmbot.rsi.distillation-runtime/1'].includes(value.schemaVersion)) throw new Error('Unsupported distillation runtime')
  if (!value.python || !isAbsolute(value.skills || '') || !isAbsolute(value.migloop?.directory || '')) throw new Error('Distillation needs Python, public MigLoop sources and built skills')
  return { ...value, path }
}

export async function invokeOffline(action, { config, output, run, runtime, signal } = {}) {
  if (!['prepare', 'check'].includes(action)) throw new Error('Unsupported offline action')
  const rt = await memoryRuntime(runtime)
  for (const path of action === 'prepare' ? [config, output] : [run]) if (!isAbsolute(path || '')) throw new Error('Offline paths must be absolute')
  const args = [fileURLToPath(new URL('./offline-prepare.py', import.meta.url)), action, ...(action === 'prepare' ? ['--config', config, '--out', output, '--runtime', rt.path] : ['--run', run])]
  const result = await runPython({ cmd: rt.python, args: [] }, args, { signal, timeoutMs: 900000 })
  if (result.code !== 0) throw new Error(result.stderr.slice(-2000) || 'Offline Memory operation failed')
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

export const prepareOffline = (config, output, options = {}) => invokeOffline('prepare', { config, output, ...options })
export const checkOffline = (run, options = {}) => invokeOffline('check', { run, ...options })

// A minimal runtime describes distillation, not a separate DSH installation.
// Preserve the invoking DSH profile/PATH unless a managed CLI is explicitly present.
export function workerEnvironment(runtime, env = process.env) {
  const rt = JSON.parse(readFileSync(runtime, 'utf8'))
  if (!rt.dshCli) return {}
  if (!isAbsolute(rt.dshCli) || (rt.dshHome && !isAbsolute(rt.dshHome))) throw new Error('Managed DSH paths must be absolute')
  return { DSH_HOME: rt.dshHome || join(dirname(runtime), 'dsh'), PATH: resolve(dirname(rt.dshCli), '../../../.bin') + delimiter + (env.PATH || '') }
}

export function commandTokens(text) {
  const tokens = []
  let token = '', quote = '', started = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) quote = ''
      else if (quote === '"' && char === '\\' && text[i + 1] === quote) { token += quote; i++ }
      else token += char
    } else if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false }
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else { token += char; started = true }
  }
  if (quote) throw new Error('Unterminated quoted argument')
  if (started) tokens.push(token)
  return tokens
}
