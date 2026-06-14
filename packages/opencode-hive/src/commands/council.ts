import type { CouncilConfig } from 'hive-core';
import type { HiveCommandAgentDescriptor } from './types.js';

export const READ_ONLY_COUNCIL_ELIGIBLE_BASES = new Set([
  'scout-researcher',
  'plan-reviewer',
  'code-reviewer',
  'simplicity-reviewer',
  'approach-advisor',
]);

const MUTABLE_COUNCIL_INELIGIBLE_BASES = new Set([
  'forager-worker',
  'hive-builder',
  'hive-helper',
  'hive-master',
  'swarm-orchestrator',
]);

export interface ResolvedCouncilMember {
  name: string;
  baseAgent: string;
  description: string;
}

export interface ResolvedCouncilMembers {
  requestedGroup: string;
  groupName: string;
  fallbackFrom?: string;
  maxMembers: number;
  members: ResolvedCouncilMember[];
  warnings: string[];
  error?: string;
}

interface GroupResolution {
  groupExists: boolean;
  maxMembers: number;
  members: ResolvedCouncilMember[];
  warnings: string[];
}

export function isReadOnlyCouncilEligibleBase(baseAgent: string): boolean {
  return READ_ONLY_COUNCIL_ELIGIBLE_BASES.has(baseAgent);
}

function isExampleTemplateAgent(name: string, descriptor: HiveCommandAgentDescriptor): boolean {
  return name.includes('example-template')
    || descriptor.description.trim().toLowerCase().startsWith('example template only');
}

function skipReasonForIneligibleBase(baseAgent: string): string {
  if (MUTABLE_COUNCIL_INELIGIBLE_BASES.has(baseAgent)) {
    return `base agent ${baseAgent} is mutable and not council-eligible`;
  }

  return `base agent ${baseAgent} is not read-only council-eligible`;
}

function resolveGroupMembers(
  council: CouncilConfig,
  agents: Record<string, HiveCommandAgentDescriptor>,
  groupName: string,
): GroupResolution {
  const group = council.groups?.[groupName];
  const maxMembers = group?.maxMembers ?? council.maxMembers ?? 4;
  const warnings: string[] = [];
  const selected = new Set<string>();
  const usableMembers: ResolvedCouncilMember[] = [];
  const excludedAgents = new Set(council.excludedAgents ?? []);

  if (!group) {
    return {
      groupExists: false,
      maxMembers,
      members: [],
      warnings: [`Group ${groupName} is not configured.`],
    };
  }

  for (const memberName of group.members) {
    const descriptor = agents[memberName];

    if (!descriptor) {
      warnings.push(`Skipped ${memberName}: not registered for this agent mode.`);
      continue;
    }

    if (excludedAgents.has(memberName)) {
      warnings.push(`Skipped ${memberName}: excluded by council configuration.`);
      continue;
    }

    if (!descriptor.available) {
      warnings.push(`Skipped ${memberName}: agent is not available in the current command context.`);
      continue;
    }

    if (isExampleTemplateAgent(memberName, descriptor)) {
      warnings.push(`Skipped ${memberName}: example-template custom agents are not usable council seats.`);
      continue;
    }

    if (!descriptor.readOnlyCouncilEligible || !isReadOnlyCouncilEligibleBase(descriptor.baseAgent)) {
      warnings.push(`Skipped ${memberName}: ${skipReasonForIneligibleBase(descriptor.baseAgent)}.`);
      continue;
    }

    if (selected.has(memberName)) {
      warnings.push(`Skipped duplicate ${memberName}: first occurrence already selected.`);
      continue;
    }

    selected.add(memberName);
    usableMembers.push({
      name: memberName,
      baseAgent: descriptor.baseAgent,
      description: descriptor.description,
    });
  }

  const members = usableMembers.slice(0, maxMembers);
  for (const member of usableMembers.slice(maxMembers)) {
    warnings.push(`Skipped ${member.name}: max member cap ${maxMembers} already reached.`);
  }

  return {
    groupExists: true,
    maxMembers,
    members,
    warnings,
  };
}

export function resolveCouncilMembers(
  council: CouncilConfig,
  agents: Record<string, HiveCommandAgentDescriptor>,
  requestedGroupOrDefault?: string,
): ResolvedCouncilMembers {
  const requestedGroup = requestedGroupOrDefault?.trim() || council.defaultGroup || 'decision';
  const requested = resolveGroupMembers(council, agents, requestedGroup);

  if (requested.members.length > 0) {
    return {
      requestedGroup,
      groupName: requestedGroup,
      maxMembers: requested.maxMembers,
      members: requested.members,
      warnings: requested.warnings,
    };
  }

  const defaultGroup = council.defaultGroup || 'decision';
  if (requestedGroup !== defaultGroup) {
    const fallback = resolveGroupMembers(council, agents, defaultGroup);
    const warnings = [
      ...requested.warnings,
      `Group ${requestedGroup} had no usable council seats; falling back to default group ${defaultGroup}.`,
      ...fallback.warnings,
    ];

    if (fallback.members.length > 0) {
      return {
        requestedGroup,
        groupName: defaultGroup,
        fallbackFrom: requestedGroup,
        maxMembers: fallback.maxMembers,
        members: fallback.members,
        warnings,
      };
    }

    return {
      requestedGroup,
      groupName: defaultGroup,
      fallbackFrom: requestedGroup,
      maxMembers: fallback.maxMembers,
      members: [],
      warnings,
      error: `No usable council members remain for requested group ${requestedGroup} or fallback group ${defaultGroup}.`,
    };
  }

  return {
    requestedGroup,
    groupName: requestedGroup,
    maxMembers: requested.maxMembers,
    members: [],
    warnings: requested.warnings,
    error: requested.groupExists
      ? `No usable council members remain for requested group ${requestedGroup}.`
      : `No usable council members remain because group ${requestedGroup} is not configured.`,
  };
}
