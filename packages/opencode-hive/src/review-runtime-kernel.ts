export const DASH_REVIEW_PRIMARY_AGENT = '__hive_dash_review_primary';
export const VULNERABILITY_REVIEW_PRIMARY_AGENT = '__hive_vulnerability_review_primary';

export const REVIEW_UNIVERSAL_METADATA_TOOLS = [
  'hive_repositories_status',
  'hive_plan_read',
  'hive_status',
] as const;

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortedUniqueCodePoints(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort(compareUnicodeCodePoints);
}

export function safeGitRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field}: must be a safe Git ref`);
  const revisionMatch = /^(.+?)(?:~\d+|\^\d*)?$/.exec(value);
  const refName = revisionMatch?.[1];
  if (
    value.startsWith('-')
    || !refName
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(refName)
    || refName.includes('..')
    || refName.includes('//')
    || refName.includes('@{')
    || refName.endsWith('.')
    || refName.endsWith('/')
    || refName.includes('/.')
  ) throw new Error(`${field}: must be a safe Git ref`);
  return value;
}
