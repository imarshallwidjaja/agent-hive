import type { CouncilConfig } from 'hive-core';
import type { BackgroundDelegationAvailability } from '../utils/background-gate.js';

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
  agentMode: 'unified' | 'dedicated';
  backgroundGuidance: BackgroundDelegationAvailability;
  council: CouncilConfig;
  agents: Record<string, HiveCommandAgentDescriptor>;
}

export interface HiveCommandAgentDescriptor {
  baseAgent: string;
  available: boolean;
  description: string;
  readOnlyCouncilEligible: boolean;
  exampleTemplate?: boolean;
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
