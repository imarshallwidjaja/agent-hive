import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';

const bundle = fs.readFileSync(new URL('../../dist/extension.js', import.meta.url), 'utf8');

describe('shipped extension artifact parity', () => {
  it('includes overview comment routing and storage in the bundle', () => {
    expect(bundle).toContain('context/overview.md');
    expect(bundle).toContain('comments/overview.json');
  });

  it('uses canonical plan comments path comments/plan.json in dist', () => {
    expect(bundle).toContain('comments/plan.json');
  });

  it('does not contain the structural LM registration API string in the bundle', () => {
    const registrationApi = ['register', 'Tool'].join('');
    expect(bundle).not.toContain(registrationApi);
  });
});
