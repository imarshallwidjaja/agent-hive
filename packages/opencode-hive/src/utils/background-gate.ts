import { nativeCall, skillCall, type HostProfile } from '../runtime/host-profile.js';

export const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';

export type BackgroundDelegationUnavailableReason =
  | 'experiment-disabled'
  | 'skill-disabled'
  | 'url-scan-incomplete'
  | 'skill-missing';

export interface BackgroundDelegationAvailability {
  available: boolean;
  reason?: BackgroundDelegationUnavailableReason;
}

type SkillMap = ReadonlyMap<string, unknown>;
type SkippedSkillMap = ReadonlyMap<string, { reason: string }>;

export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

export function isBackgroundSubagentsExperimentEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isTruthyEnv(env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
    || isTruthyEnv(env.OPENCODE_EXPERIMENTAL);
}

export function resolveBackgroundDelegationAvailability(
  nativeSkillsByName: SkillMap,
  eligibleHiveSkills: SkillMap,
  skippedHiveSkills: SkippedSkillMap,
  host: HostProfile,
  env: Record<string, string | undefined> = process.env,
): BackgroundDelegationAvailability {
  // Only a host that gates background subagents behind an experiment variable consults the environment.
  if (host.backgroundGate === 'experiment-env' && !isBackgroundSubagentsExperimentEnabled(env)) {
    return { available: false, reason: 'experiment-disabled' };
  }

  if (
    nativeSkillsByName.has(BACKGROUND_DELEGATION_SKILL_ID)
    || eligibleHiveSkills.has(BACKGROUND_DELEGATION_SKILL_ID)
  ) {
    return { available: true };
  }

  const skippedSkill = skippedHiveSkills.get(BACKGROUND_DELEGATION_SKILL_ID);
  if (skippedSkill?.reason === 'disabled') {
    return { available: false, reason: 'skill-disabled' };
  }

  if (skippedSkill?.reason === 'url-scan-incomplete') {
    return { available: false, reason: 'url-scan-incomplete' };
  }

  return { available: false, reason: 'skill-missing' };
}

/** Primary-session guidance that opens background wait mode and the Hive board protocol. */
export function renderBackgroundFirstOrchestrationAppendix(host: HostProfile): string {
  return `\n\n## Background-First Orchestration\nThis appendix applies only when running as a primary. When Architect is task-spawned, use blocking calls for its permitted terminal planning-helper layer, including hive-helper. Child-role rules take precedence over this appendix: child sessions cannot use background board tools, so return board/control requests to the parent without loading the primary-only background-delegation skill. OpenCode background subagents are enabled for primary sessions. Delegation-first orchestration is the baseline; this appendix only opens background wait mode and the Hive board protocol. When this heading is present in a primary session, background-delegation governs scheduling and wait mode; other loaded skills govern domain workflow and safety. Before launching or managing background lanes, load/use ${skillCall(host, 'background-delegation', { code: false })}. Background mode is available only when useful unrelated foreground work can continue; otherwise use blocking. Detailed safety overrides and board protocol live in that skill. Gate-closed sessions keep normal blocking ${nativeCall(host)} wait mode and must launch returned blocking task calls rather than working directly in delegated worktrees.`;
}
