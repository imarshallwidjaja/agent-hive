import { tool } from '@opencode-ai/plugin';
import type { TaskTraceSummarizerConfig } from 'hive-core';
import { createTraceHandlers, record, TRACE_TOOL_DEFINITIONS } from './trace/engine.js';
import { createV1Summarizer, createV1TraceSource, isDirectChildSession, recordedChildSession, type TaskTraceClient } from './trace/v1-source.js';

/**
 * The OpenCode v1 owner of `hive_task_trace` and `hive_task_trace_content`: v1 tool registration over the shared
 * trace engine (trace/engine.ts) with the v1 client source, plus the v1 task-result and replay hints.
 */

export { TASK_TRACE_SUMMARIZER_AGENT, TASK_TRACE_SUMMARIZER_PROMPT } from './trace/types.js';
export { isDirectChildSession };

type RecordValue = Record<string, unknown>;

// Children considered for replay hints per transform, bounding session lookups on long histories.
const MAX_REPLAY_HINT_CHILDREN = 8;

export interface TaskTraceOptions {
  client: TaskTraceClient;
  directory: string;
  summarizer: TaskTraceSummarizerConfig;
  ephemeralSessionIDs: Set<string>;
}

export function createTaskTraceTools(options: TaskTraceOptions) {
  const handlers = createTraceHandlers(
    createV1TraceSource(options.client, options.directory),
    createV1Summarizer({ client: options.client, directory: options.directory, config: options.summarizer, ephemeralSessionIDs: options.ephemeralSessionIDs }),
  );
  return {
    hive_task_trace: tool({
      ...TRACE_TOOL_DEFINITIONS.hive_task_trace,
      execute: (args, context) => handlers.trace(args, { sessionID: context.sessionID, ...(args.recovery ? { abort: context.abort } : {}) }),
    }),
    hive_task_trace_content: tool({
      ...TRACE_TOOL_DEFINITIONS.hive_task_trace_content,
      execute: (args, context) => handlers.content(args, { sessionID: context.sessionID }),
    }),
  };
}

export function appendTaskTraceHint(input: { tool?: string }, output: { output: string; metadata?: unknown } | undefined): void {
  if (!output || input.tool !== 'task') return;
  const metadata = record(output.metadata);
  const sessionID = typeof metadata?.sessionId === 'string' ? metadata.sessionId.trim() : '';
  if (!sessionID) return;
  const hint = taskTraceContinuationHint(sessionID);
  if ((output.output ?? '').includes(hint)) return;
  output.output = `${output.output ?? ''}${output.output ? '\n\n' : ''}${hint}`;
}

function taskTraceContinuationHint(
  taskID: string,
  leadIn = `[hive task trace] If this child failed, blocked, timed out, was cancelled, returned empty output, or its result is unclear, inspect it with hive_task_trace({ task_id: ${JSON.stringify(taskID)} }).`,
): string {
  return `${leadIn} Read lifecycle, context, and the chronological event index first; follow coverage.next_cursor for more events and use hive_task_trace_content for guarded event detail. Every returned task result is terminal; launch a fresh child session for follow-up and reuse the same Hive task/worktree where appropriate. Pass task_id only when an explicit operator instruction or an explicit runtime-owned interruption-recovery mechanism authorizes continuation; otherwise launch fresh. If the child may still be active or its lifecycle is uncertain, inspect, wait, or reattach as supported; do not send another prompt or launch an overlapping writer.`;
}

// Chooses the replay hint for one recorded native task call, or none. A foreground call without a
// recorded result is hinted only once a later message exists; that alone does not prove it stopped.
// Background launches belong to the board, so no branch hints them. Native task records the launch
// mode in state.metadata; the recorded input and a part-metadata mirror are honored as well.
function replayHintLeadIn(part: RecordValue, childID: string, laterMessageExists: boolean): string | undefined {
  const state = record(part.state);
  if ([state?.metadata, state?.input, part.metadata].some((value) => record(value)?.background === true)) return undefined;
  const status = String(state?.status);
  const trace = `hive_task_trace({ task_id: ${JSON.stringify(childID)} })`;
  if (
    (status === 'completed' && (state?.output === '' || state?.output === undefined))
    || ['error', 'failed', 'blocked', 'cancelled', 'timed_out', 'timeout'].includes(status)
  ) {
    return `[hive task trace] This task result is empty or terminally unsuccessful. Inspect the runtime-visible session with ${trace}.`;
  }
  if ((status === 'pending' || status === 'running') && laterMessageExists) {
    return `[hive task trace] This task call has no recorded result; the child may still be in flight. Inspect the runtime-visible session with ${trace} before relying on or replacing its work.`;
  }
  return undefined;
}

// The runtime passes a freshly loaded message array each turn, so hints are rebuilt on every call
// rather than remembered. Messages and their parts are scanned newest first, and only each child's
// newest recorded call decides its hint: a later result supersedes an older call without one.
// Authorization lookups are capped per call and spent only on calls that would be hinted.
export async function injectTaskTraceHint(
  messages: Array<{ info?: unknown; parts?: unknown[] }>,
  authorize: (childID: string, parentID: string) => Promise<boolean>,
): Promise<void> {
  const decided = new Set<string>();
  let lookups = 0;
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message = messages[position];
    const info = record(message.info);
    const parentID = typeof info?.sessionID === 'string' ? info.sessionID : undefined;
    if (!parentID || !Array.isArray(message.parts)) continue;
    for (const rawPart of [...message.parts].reverse()) {
      const part = record(rawPart);
      if (!part) continue;
      // A hint left by an earlier pass over this same array already covers its child.
      if (part.hiveTaskTraceHint === true && typeof part.hiveTaskTraceChild === 'string') {
        if (!decided.has(part.hiveTaskTraceChild)) lookups += 1;
        decided.add(part.hiveTaskTraceChild);
        continue;
      }
      const childID = recordedChildSession(part).id;
      if (childID === undefined || decided.has(childID)) continue;
      decided.add(childID);
      const leadIn = replayHintLeadIn(part, childID, position < messages.length - 1);
      if (leadIn === undefined) continue;
      if (lookups >= MAX_REPLAY_HINT_CHILDREN) return;
      lookups += 1;
      if (!(await authorize(childID, parentID))) continue;
      message.parts.push({
        id: `hive-task-trace-hint-${String(part.id ?? childID)}`,
        sessionID: parentID,
        messageID: info?.id,
        type: 'text',
        synthetic: true,
        hiveTaskTraceHint: true,
        hiveTaskTraceChild: childID,
        text: taskTraceContinuationHint(childID, leadIn),
      });
    }
  }
}
