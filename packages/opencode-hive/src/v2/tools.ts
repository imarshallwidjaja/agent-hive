import { Effect } from 'effect';
import type { Scope } from 'effect';
import { Tool } from '@opencode/schema/tool';
import type { Plugin } from '@opencode/plugin/effect';
import { json, type HiveOperation } from '../runtime/hive-tools.js';
import { CODEMODE_READ_TOOLS, type ReadTransport } from '../runtime/host-profile.js';
import { z } from '../runtime/schema.js';

/**
 * OpenCode v2 registration of Hive tools. Every Hive tool family (ordinary operations, background, trace) goes
 * through one registrar, so the Code Mode flags and the execution guard cannot drift between families.
 */

/** The caller of one tool execution, as the v2 host reports it. */
export type HiveCaller = { sessionID: string; agent: string };

/** Decides whether a caller may run a Hive tool. Fails with the reason when it may not. */
export type HiveToolGuard = (tool: string, caller: HiveCaller) => Effect.Effect<void, Tool.Error>;

/**
 * A Standard Schema view of an existing Zod schema, with the JSON Schema export the v2 host needs. The host only
 * converts Zod schemas built from its own Zod instance, and this package bundles its own, so it relies on the
 * schema's declared `jsonSchema` instead. Validation is Zod's own Standard Schema validator, unchanged.
 */
export type StandardJsonSchema<Schema extends z.ZodType> = {
  readonly '~standard': Schema['~standard'] & {
    readonly jsonSchema: Record<'input' | 'output', (options: { target: string }) => Record<string, unknown>>;
  };
};

export function standardSchema<Schema extends z.ZodType>(schema: Schema): StandardJsonSchema<Schema> {
  return {
    '~standard': {
      ...schema['~standard'],
      jsonSchema: {
        input: () => z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>,
        output: () => z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' }) as Record<string, unknown>,
      },
    },
  };
}

/** The structured result a `json` operation declares: any JSON value, as its v1 JSON presentation encodes it. */
const jsonResult = standardSchema(z.json());

/**
 * Whether a Hive tool runs inside Code Mode. Only the admitted reads do, and only with the `codemode` transport;
 * every other Hive tool, and every tool under `direct`, is a direct call. The value is always explicit, because the
 * host treats an absent flag as Code Mode.
 */
export function codemodeFlag(tool: string, transport: ReadTransport): boolean {
  return transport === 'codemode' && (CODEMODE_READ_TOOLS as readonly string[]).includes(tool);
}

export interface HiveToolRegistrar {
  readonly readTransport: ReadTransport;
  /**
   * Registers Hive tools in one tool transform for the activation's scope. Each tool validates its input with its
   * own Zod arguments, runs the guard before any effect, and returns the operation's structured result (`json`) or
   * text (`text`). Callers do not choose Code Mode flags.
   */
  register(tools: Record<string, HiveOperation>): Effect.Effect<void, never, Scope.Scope>;
}

export function createHiveToolRegistrar(input: { context: Plugin.Context; readTransport: ReadTransport; guard: HiveToolGuard }): HiveToolRegistrar {
  const { context, readTransport, guard } = input;
  return {
    readTransport,
    register: (tools) => context.tool.transform((editor) => {
      for (const [name, operation] of Object.entries(tools)) editor.add(toToolInfo(name, operation, readTransport, guard));
    }).pipe(Effect.asVoid),
  };
}

/** The v2 tool definition for one Hive operation. Exported for registration tests. */
export function toToolInfo(name: string, operation: HiveOperation, readTransport: ReadTransport, guard: HiveToolGuard): Tool.Info {
  const execute = (args: unknown, context: Tool.Context) => guard(name, { sessionID: context.sessionID, agent: context.agent }).pipe(
    Effect.andThen(Effect.tryPromise({
      // The signal aborts when the host interrupts the call, so operations with long stages can stop with it.
      try: async (signal) => operation.execute(args, { sessionID: context.sessionID, signal }),
      catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
    })),
    Effect.map((result) => {
      if (operation.output === 'text') return { content: String(result) };
      // The v1 presentation is the JSON text; the structured output is that same JSON, so both hosts agree.
      const text = json(result) ?? 'null';
      return { output: JSON.parse(text) as z.core.util.JSONType, content: text };
    }),
  );
  return {
    name,
    description: operation.description,
    input: standardSchema(z.object(operation.args)),
    ...(operation.output === 'json' ? { output: jsonResult } : {}),
    options: { codemode: codemodeFlag(name, readTransport) },
    execute,
  } satisfies Tool.Info;
}
