import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';

describe('extension review routing', () => {
  const source = fs.readFileSync(new URL('../extension.ts', import.meta.url), 'utf-8');

  it('supports review-target handling for both plan.md and overview.md', () => {
    expect(source).toContain("planMatch = normalizedPath.match(/\\.hive\\/features\\/([^/]+)\\/plan\\.md$/)");
    expect(source).toContain("overviewMatch = normalizedPath.match(/\\.hive\\/features\\/([^/]+)\\/context\\/overview\\.md$/)");
    expect(source).toContain("document: 'plan'");
    expect(source).toContain("document: 'overview'");
  });

  it('guards legacy comments fallback to plan documents only', () => {
    expect(source).toContain("if (document === 'plan')");
    expect(source).toContain("return path.join(workspaceRoot, '.hive', 'features', featureName, 'comments.json')");
  });

  it('uses canonical comments path with document-specific filename for both plan and overview', () => {
    expect(source).toContain("const canonicalPath = path.join(workspaceRoot, '.hive', 'features', featureName, 'comments', `${document}.json`)");
    expect(source).toContain("if (fs.existsSync(canonicalPath))");
  });
});
