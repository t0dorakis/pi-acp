import type { Usage, UsageUpdate } from '@agentclientprotocol/sdk'

type TokenTotals = {
  input: number
  output: number
  total: number
  cacheRead?: number
  cacheWrite?: number
}

export type PiUsageSnapshot = {
  sessionId: string
  tokens: TokenTotals
  cost?: number
  context?: {
    tokens: number
    contextWindow: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cumulativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function optionalCumulativeNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined
  return cumulativeNumber(value)
}

export function parsePiUsageSnapshot(value: unknown): PiUsageSnapshot | null {
  if (!isRecord(value) || !isRecord(value.tokens)) return null

  const sessionId = typeof value.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : null
  const input = cumulativeNumber(value.tokens.input)
  const output = cumulativeNumber(value.tokens.output)
  const total = cumulativeNumber(value.tokens.total)
  const cacheRead = optionalCumulativeNumber(value.tokens.cacheRead)
  const cacheWrite = optionalCumulativeNumber(value.tokens.cacheWrite)
  const cost = optionalCumulativeNumber(value.cost)

  if (
    sessionId === null ||
    input === null ||
    output === null ||
    total === null ||
    cacheRead === null ||
    cacheWrite === null ||
    cost === null
  ) {
    return null
  }
  if (cacheRead !== undefined && cacheWrite !== undefined && total !== input + output + cacheRead + cacheWrite) {
    return null
  }

  const snapshot: PiUsageSnapshot = {
    sessionId,
    tokens: {
      input,
      output,
      total,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite })
    },
    ...(cost === undefined ? {} : { cost })
  }

  if (isRecord(value.contextUsage)) {
    const contextWindow = cumulativeNumber(value.contextUsage.contextWindow)
    const contextTokens = cumulativeNumber(value.contextUsage.tokens)
    if (contextWindow !== null && contextWindow > 0 && contextTokens !== null) {
      snapshot.context = { tokens: contextTokens, contextWindow }
    }
  }

  return snapshot
}

export function isNonDecreasingUsage(before: PiUsageSnapshot, after: PiUsageSnapshot): boolean {
  const required =
    before.sessionId === after.sessionId &&
    after.tokens.input >= before.tokens.input &&
    after.tokens.output >= before.tokens.output &&
    after.tokens.total >= before.tokens.total &&
    (before.cost === undefined || after.cost === undefined || after.cost >= before.cost)

  if (!required) return false

  for (const key of ['cacheRead', 'cacheWrite'] as const) {
    const previous = before.tokens[key]
    const current = after.tokens[key]
    if (previous !== undefined && current !== undefined && current < previous) return false
  }

  return true
}

export function promptUsageDelta(before: PiUsageSnapshot, after: PiUsageSnapshot): Usage | null {
  if (!isNonDecreasingUsage(before, after)) return null

  const cachedReadTokens =
    before.tokens.cacheRead === undefined || after.tokens.cacheRead === undefined
      ? undefined
      : after.tokens.cacheRead - before.tokens.cacheRead
  const cachedWriteTokens =
    before.tokens.cacheWrite === undefined || after.tokens.cacheWrite === undefined
      ? undefined
      : after.tokens.cacheWrite - before.tokens.cacheWrite

  return {
    inputTokens: after.tokens.input - before.tokens.input,
    outputTokens: after.tokens.output - before.tokens.output,
    totalTokens: after.tokens.total - before.tokens.total,
    ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens })
  }
}

export function usageUpdate(snapshot: PiUsageSnapshot): UsageUpdate | null {
  if (!snapshot.context) return null

  return {
    used: snapshot.context.tokens,
    size: snapshot.context.contextWindow,
    ...(snapshot.cost === undefined ? {} : { cost: { amount: snapshot.cost, currency: 'USD' } })
  }
}
