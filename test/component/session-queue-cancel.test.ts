import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')
  await new Promise(resolve => setTimeout(resolve, 0))

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  // queued prompts should resolve as cancelled
  assert.deepEqual(await second, { stopReason: 'cancelled' })
  assert.deepEqual(await third, { stopReason: 'cancelled' })

  // finish first prompt as cancelled after abort
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.deepEqual(await first, { stopReason: 'cancelled' })

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
})

test('Pi child exits after acknowledging a prompt: the open turn and its queue fail', async () => {
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: []
  })
  const turns = Promise.allSettled([session.prompt('one'), session.prompt('two')])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proc.prompts.length, 1)
  proc.exit(new Error('pi process exited'))
  for (const result of await turns) {
    assert.equal(result.status, 'rejected')
    assert.match(String(result.reason), /pi process exited/)
  }
})
