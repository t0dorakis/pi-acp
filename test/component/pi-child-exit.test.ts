import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import test from 'node:test'

const fixture = `
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, type } = JSON.parse(line)
  const model = { provider: 'fixture', id: 'test' }
  const data = {
    get_state: { model, thinkingLevel: 'off' },
    get_available_models: { models: [model] },
    get_available_thinking_levels: { levels: ['off'] },
    get_commands: { commands: [] },
  }[type]
  const reply = JSON.stringify({ type: 'response', id, command: type, success: true, data }) + '\\n'
  process.stdout.write(reply, () => {
    if (type !== 'prompt') return
    process.stderr.write('x'.repeat(32_768) + '\\n')
    process.stderr.write('TypeError: secret-fixture-token\\n    at run (/private/path/dist/modes/rpc/rpc-mode.js:660:4)\\n', () => process.exit(1))
  })
})
`

test(
  'ACP reports a safe diagnosis exactly once when Pi dies after accepting a prompt',
  { timeout: 5_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-exit-'))
    const windows = process.platform === 'win32'
    const launcher = join(root, windows ? 'pi.cmd' : 'pi')
    const script = join(root, 'fixture.cjs')
    writeFileSync(script, fixture)
    writeFileSync(
      launcher,
      windows
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 }
    )
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/index.ts')], {
      cwd: process.cwd(),
      env: { ...process.env, PI_ACP_PI_COMMAND: launcher, PI_CODING_AGENT_DIR: root },
      stdio: 'pipe'
    })
    const closed = once(child, 'close')
    const output: string[] = []
    const errors: Buffer[] = []
    child.stderr.on('data', chunk => errors.push(chunk))
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => output.push(line))
    const input = lines[Symbol.asyncIterator]()
    const send = (id: number, method: string, params: object) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    }
    const receive = async (ids: number[]) => {
      const remaining = new Set(ids)
      const responses = []
      while (remaining.size > 0) {
        const line = await input.next()
        assert.equal(line.done, false)
        const message = JSON.parse(line.value!)
        if (remaining.delete(message.id)) responses.push(message)
      }
      return responses
    }
    try {
      send(1, 'initialize', { protocolVersion: 1 })
      await receive([1])
      send(2, 'session/new', { cwd: root, mcpServers: [] })
      const [session] = await receive([2])
      assert.ok(session.result?.sessionId, JSON.stringify(session.error))
      const prompt = { sessionId: session.result.sessionId, prompt: [{ type: 'text', text: 'review' }] }
      send(3, 'session/prompt', prompt)
      send(4, 'session/prompt', prompt)
      for (const turn of await receive([3, 4])) {
        assert.equal(turn.error?.code, -32603)
        assert.match(turn.error.data.details, /pi process exited \(code=1, signal=null\).*TypeError.*Pi RPC/)
      }
      child.stdin.end()
      await closed
      for (const id of [3, 4]) assert.equal(output.filter(line => JSON.parse(line).id === id).length, 1)
      assert.doesNotMatch(
        output.join('\n') + Buffer.concat(errors).toString(),
        /secret-fixture-token|\/private\/path|x{50}/
      )
    } finally {
      child.kill()
      await closed
      rmSync(root, { recursive: true, force: true })
    }
  }
)
