import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';

const source = fs.readFileSync(new URL('./planCommentController.ts', import.meta.url), 'utf-8');

describe('PlanCommentController', () => {
  it('supports plan and overview as reviewable document targets', () => {
    expect(source).toContain("document: 'plan'");
    expect(source).toContain("document: 'overview'");
    expect(source).toContain('context/overview.md');
  });

  it('maps plan and overview comment files back to review targets using canonical paths', () => {
    expect(source).toContain('comments/plan.json');
    expect(source).toContain('comments/overview.json');
    expect(source).toContain('comments.json');
  });

  it('writes new comments to the canonical document-specific comments file', () => {
    expect(source).toContain("comments', `${doc}.json`");
    expect(source).toContain('comments/plan.json');
  });
});
