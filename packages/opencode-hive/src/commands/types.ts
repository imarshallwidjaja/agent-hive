export interface HiveCommandMetadata {
  key: string;
  name: string;
  description: string;
}

export interface HiveRuntimeCommand {
  description: string;
  run(args: string): Promise<string> | string;
}

export type HiveRuntimeCommandMap = Record<string, HiveRuntimeCommand>;

export interface HiveCommandContext {
  directory: string;
  worktree: string;
}

export type HiveCommandContextFactory = () => HiveCommandContext;

export type HiveCommandRenderer = (
  args: string,
  context: HiveCommandContext,
) => Promise<string> | string;

export type HiveCommandRenderers<TCommandKey extends string = string> = Record<
  TCommandKey,
  HiveCommandRenderer
>;
