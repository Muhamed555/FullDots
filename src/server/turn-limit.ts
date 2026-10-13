// When a Dot's turn is asked to wrap up and when it is stopped. Most turns get AGENT_TURN_TIMEOUT
// and then AGENT_TURN_GRACE to write their summary. A teammate's turn on handed-over work carries
// its own limit (DELEGATION_TIMEOUT) in the turn metadata; that limit is the whole turn, so the
// wrap-up request comes a grace period before it.
import type { RunAgentInput } from '@ag-ui/core';
import { hasTimeLimit, NO_TIME_LIMIT_MS, type Limits } from './limits.js';

export interface TurnTimers {
  /** The limit the owner configured, for the "I stopped" notice. */
  limitMs: number;
  /** When the Dot is asked to wrap up. */
  wrapUpMs: number;
  /** When the turn is stopped. */
  stopMs: number;
}

/** The per-turn limit a delegation turn carries, if any. */
export function delegationTurnLimit(
  messages: RunAgentInput['messages'],
): number | undefined {
  const last = messages.findLast((message) => message.role === 'user') as
    { metadata?: { source?: unknown; turnLimitMs?: unknown } } | undefined;
  const limit = last?.metadata?.turnLimitMs;
  if (last?.metadata?.source !== 'delegation') return undefined;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? Math.min(limit, NO_TIME_LIMIT_MS)
    : undefined;
}

/** Undefined when the turn has no time limit at all. */
export function turnTimers(
  limits: Pick<Limits, 'agentTurnMs' | 'agentGraceMs'>,
  messages: RunAgentInput['messages'],
): TurnTimers | undefined {
  const own = delegationTurnLimit(messages);
  if (own !== undefined) {
    if (!hasTimeLimit(own)) return undefined;
    return {
      limitMs: own,
      wrapUpMs: own - Math.min(limits.agentGraceMs, own / 4),
      stopMs: own,
    };
  }
  if (!hasTimeLimit(limits.agentTurnMs)) return undefined;
  return {
    limitMs: limits.agentTurnMs,
    wrapUpMs: limits.agentTurnMs,
    stopMs: limits.agentTurnMs + limits.agentGraceMs,
  };
}
