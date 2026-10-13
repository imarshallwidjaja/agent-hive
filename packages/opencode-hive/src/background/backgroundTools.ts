import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { presentHiveResult } from '../runtime/hive-tools.js';
import { createBackgroundOperations, type BoardInvocation, type CreateBackgroundOperationsOptions } from './operations.js';

export type { BoardInvocation, RuntimeCancelResult } from './operations.js';
export type CreateBackgroundToolsOptions = CreateBackgroundOperationsOptions;

/** V1 registration of the shared board operations: plugin tools whose result is the operation's JSON text. */
export function createBackgroundTools(options: CreateBackgroundToolsOptions): Record<string, ToolDefinition> {
  return Object.fromEntries(Object.entries(createBackgroundOperations(options)).map(([name, operation]) => [name, tool({
    description: operation.description,
    args: operation.args,
    execute: async (input, context) => {
      const invocation: BoardInvocation = { sessionID: context?.sessionID, agent: context?.agent };
      return presentHiveResult(operation, await operation.execute(input, invocation));
    },
  })]));
}
