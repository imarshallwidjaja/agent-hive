export const BACKGROUND_DELEGATION_SKILL_ID = 'background-delegation';

export type BackgroundDelegationUnavailableReason =
  | 'experiment-disabled'
  | 'skill-disabled'
  | 'url-scan-incomplete'
  | 'skill-missing'
  | 'availability-unknown';

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
  agentName: string,
  nativeSkillsByName: SkillMap,
  eligibleHiveSkills: SkillMap,
  skippedHiveSkills: SkippedSkillMap,
  env: Record<string, string | undefined> = process.env,
): BackgroundDelegationAvailability {
  void agentName;

  if (!isBackgroundSubagentsExperimentEnabled(env)) {
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
