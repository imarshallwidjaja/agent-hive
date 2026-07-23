import { describe, expect, it } from 'bun:test';
import { isValidRepositoryConfig } from './repositoryConfig.js';

describe('isValidRepositoryConfig', () => {
  it.each([
    '/var/repos/api',
    'C:\\repos\\api',
    '\\\\server\\share\\api',
  ])('rejects absolute repository path %s on every host', (repositoryPath) => {
    expect(isValidRepositoryConfig({ id: 'api', path: repositoryPath })).toBe(false);
  });

  it('accepts a contained project-relative repository path', () => {
    expect(isValidRepositoryConfig({ id: 'api', path: './packages/api' })).toBe(true);
  });
});
