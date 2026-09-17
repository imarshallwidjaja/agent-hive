export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

export function sortedUniqueCodePoints(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function safeGitRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\s~^:?*[\\\x00-\x1f\x7f]/u.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('/')) {
    throw new Error(`${field}: invalid Git ref`);
  }
  return value;
}
import { isDeepStrictEqual } from 'node:util';

export const isDeepEqual = isDeepStrictEqual;
