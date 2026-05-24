export const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidRepositoryId(id: string): boolean {
  return REPOSITORY_ID_PATTERN.test(id) && !id.includes('..') && !id.endsWith('.lock');
}
