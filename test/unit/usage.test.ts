import test from 'node:test'
import assert from 'node:assert/strict'
import { isNonDecreasingUsage, parsePiUsageSnapshot, promptUsageDelta, usageUpdate } from '../../src/acp/usage.js'

function stats(input: number, output: number, cacheRead: number, cacheWrite: number, cost = 0) {
  return {
    sessionId: 'session-1',
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite
    },
    cost,
    contextUsage: { tokens: input + cacheRead + cacheWrite, contextWindow: 200_000, percent: 1 }
  }
}

test('usage: computes fresh and resumed per-prompt cumulative deltas', () => {
  const freshBefore = parsePiUsageSnapshot(stats(0, 0, 0, 0))!
  const freshAfter = parsePiUsageSnapshot(stats(20, 5, 0, 0, 0.01))!
  assert.deepEqual(promptUsageDelta(freshBefore, freshAfter), {
    inputTokens: 20,
    outputTokens: 5,
    totalTokens: 25,
    cachedReadTokens: 0,
    cachedWriteTokens: 0
  })

  const resumedBefore = parsePiUsageSnapshot(stats(1_000, 100, 500, 20, 0.5))!
  const resumedAfter = parsePiUsageSnapshot(stats(1_030, 112, 700, 25, 0.6))!
  assert.deepEqual(promptUsageDelta(resumedBefore, resumedAfter), {
    inputTokens: 30,
    outputTokens: 12,
    totalTokens: 247,
    cachedReadTokens: 200,
    cachedWriteTokens: 5
  })
})

test('usage: cache deltas are omitted unless both cumulative snapshots provide them', () => {
  const before = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 10, output: 2, total: 12 },
    cost: 0
  })!
  const after = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 15, output: 4, total: 22, cacheRead: 3 },
    cost: 0
  })!

  assert.deepEqual(promptUsageDelta(before, after), {
    inputTokens: 5,
    outputTokens: 2,
    totalTokens: 10
  })
})

test('usage: rejects malformed and decreasing cumulative stats', () => {
  for (const malformed of [
    null,
    {},
    { sessionId: 'session-1', tokens: { input: 1, output: 2 }, cost: 0 },
    { sessionId: 'session-1', tokens: { input: -1, output: 2, total: 1 }, cost: 0 },
    { sessionId: 'session-1', tokens: { input: 1, output: Number.NaN, total: 1 }, cost: 0 },
    {
      sessionId: 'session-1',
      tokens: { input: 1, output: 2, total: 3, cacheRead: Number.POSITIVE_INFINITY },
      cost: 0
    },
    { sessionId: 'session-1', tokens: { input: 1, output: 2, total: 3 }, cost: -1 },
    {
      sessionId: 'session-1',
      tokens: { input: 1, output: 2, total: 99, cacheRead: 0, cacheWrite: 0 },
      cost: 0
    }
  ]) {
    assert.equal(parsePiUsageSnapshot(malformed), null)
  }

  const before = parsePiUsageSnapshot(stats(10, 5, 2, 1, 0.2))!
  const after = parsePiUsageSnapshot(stats(9, 6, 2, 1, 0.3))!
  assert.equal(isNonDecreasingUsage(before, after), false)
  assert.equal(promptUsageDelta(before, after), null)

  const differentSession = { ...parsePiUsageSnapshot(stats(11, 6, 2, 1, 0.3))!, sessionId: 'session-2' }
  assert.equal(promptUsageDelta(before, differentSession), null)
})

test('usage: maps context occupancy and cumulative USD without substituting null tokens', () => {
  const available = parsePiUsageSnapshot(stats(10, 2, 4, 1, 0.25))!
  assert.deepEqual(usageUpdate(available), {
    used: 15,
    size: 200_000,
    cost: { amount: 0.25, currency: 'USD' }
  })

  const unavailable = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 10, output: 2, total: 12 },
    cost: 0.25,
    contextUsage: { tokens: null, contextWindow: 200_000, percent: null }
  })!
  assert.equal(usageUpdate(unavailable), null)

  const costUnavailable = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 10, output: 2, total: 12 },
    contextUsage: { tokens: 10, contextWindow: 200_000 }
  })!
  assert.deepEqual(usageUpdate(costUnavailable), { used: 10, size: 200_000 })
})

test('usage: malformed context does not suppress valid token accounting', () => {
  const before = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 1, output: 2, total: 3 },
    contextUsage: { tokens: null, contextWindow: 100 }
  })!
  const after = parsePiUsageSnapshot({
    sessionId: 'session-1',
    tokens: { input: 4, output: 3, total: 7 },
    contextUsage: { tokens: 'unknown', contextWindow: 100 }
  })!

  assert.deepEqual(promptUsageDelta(before, after), {
    inputTokens: 3,
    outputTokens: 1,
    totalTokens: 4
  })
  assert.equal(usageUpdate(after), null)
})
