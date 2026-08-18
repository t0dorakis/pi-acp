import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
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
  return { conn, proc, session }
}

const payload = {
  version: 1,
  settlements: [
    { id: 'run-1', label: 'worker', model: 'openai/model', status: 'completed', usage: { costKind: 'api' } }
  ]
}

async function finish(proc: FakePiRpcProcess) {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

test('settlement entry during a turn is attached verbatim under response metadata', async () => {
  const { proc, session } = makeSession()
  const prompt = session.prompt('hello')
  await new Promise(resolve => setTimeout(resolve, 0))

  proc.emit({ type: 'entry_appended', entry: { customType: 'lean-subagent-settlements', data: payload } })
  await finish(proc)

  assert.deepEqual(await prompt, {
    stopReason: 'end_turn',
    _meta: { helix: { leanSubagentSettlements: payload } }
  })
})

test('settlement entries with a version other than one are ignored', async () => {
  const { proc, session } = makeSession()
  const prompt = session.prompt('hello')
  await new Promise(resolve => setTimeout(resolve, 0))

  proc.emit({
    type: 'entry_appended',
    entry: { customType: 'lean-subagent-settlements', data: { ...payload, version: 2 } }
  })
  await finish(proc)

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
})

test('settlement entries outside a turn do not leak into the next turn', async () => {
  const { proc, session } = makeSession()
  proc.emit({ type: 'entry_appended', entry: { customType: 'lean-subagent-settlements', data: payload } })

  const prompt = session.prompt('hello')
  await new Promise(resolve => setTimeout(resolve, 0))
  await finish(proc)

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
})

test('a failed turn clears its buffered settlement', async () => {
  const { proc, session } = makeSession()
  const failed = session.prompt('fail')
  await new Promise(resolve => setTimeout(resolve, 0))
  proc.emit({ type: 'entry_appended', entry: { customType: 'lean-subagent-settlements', data: payload } })
  proc.emit({ type: 'auto_retry_end', success: false, attempt: 1 })
  proc.emit({ type: 'agent_settled' })

  await assert.rejects(failed)

  const next = session.prompt('next')
  await new Promise(resolve => setTimeout(resolve, 0))
  await finish(proc)
  assert.deepEqual(await next, { stopReason: 'end_turn' })
})

test('other custom entry types retain fall-through behavior', async () => {
  const { proc, session } = makeSession()
  const prompt = session.prompt('hello')
  await new Promise(resolve => setTimeout(resolve, 0))

  proc.emit({ type: 'entry_appended', entry: { customType: 'other-entry', data: payload } })
  await finish(proc)

  assert.deepEqual(await prompt, { stopReason: 'end_turn' })
})
