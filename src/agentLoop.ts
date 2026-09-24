/**
 * agentLoop.ts — Extracted agent loop body from Agent.run()
 *
 * This module contains the executeTurn() method that was previously
 * inlined in the ~7,000-line run() method in agent.ts.
 *
 * The outer run() method in agent.ts now calls:
 *   while (true) {
 *     const result = await this.executeTurn(turnIdx, model, post, ctx);
 *     if (result.kind !== 'continue') { _loopExitReason = result.reason; break; }
 *     turnIdx++;
 *   }
 */

import { logInfo, logWarn, logError } from './logger';
import type { OllamaMessage } from './ollamaClient';
import type { PostFn } from './preEdit';
import type { Agent } from './agent';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoopResult =
  | { kind: 'continue' }
  | { kind: 'stop'; reason: 'complete' | 'stop' | 'exhausted' | 'error' | string }
  | { kind: 'break'; reason: string };

export interface TurnContext {
  turn: number;
  model: string;
  post: PostFn;
  history: OllamaMessage[];
  userMessage: string;
  conflictNote: string;
  scopeNote: string;
  isConfirmation: boolean;
  isVagueScope: boolean;
  isDiagnosisTask: boolean;
  isUrlValidationTask: boolean;
  snapshotDir: string | null;
  _loopExitReason: string;
  _numPredictOverride: number | null;
  _isThinkingModel: boolean;
  toolMode: 'native' | 'text';
  // Mutable state that the loop writes back
  _lastContextPct: number | null;
  _confirmTimedOut: boolean;
}

// ─── executeTurn ─────────────────────────────────────────────────────────────

/**
 * Executes one full turn of the agent loop.
 * Called by Agent.run() in a while(true) loop.
 *
 * STATUS: Skeleton only. The body (~4,600 lines) is still in agent.ts run().
 * Extraction requires making Agent's private properties accessible to this
 * module (or converting this to a private method on Agent). See
 * plans/run-decomposition.md phase 5c.
 */
export async function executeTurn(
  agent: Agent,
  ctx: TurnContext,
): Promise<LoopResult> {
  // TODO: Extract from agent.ts run() method lines 4604–9202
  // This is the main loop body. See plans/run-decomposition.md for details.
  throw new Error('executeTurn not yet implemented — extraction in progress');
}
