import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { reviewTargetForDocument, reviewTargetForComments, reviewDocumentPath, reviewCommentsPath, findReviewCommentsPath } from '../reviewRouting.js';

describe('review routing', () => {
  for (const root of ['/workspace', 'C:\\Workspace', '\\\\Server\\Share\\Workspace']) {
    const paths = root.startsWith('/') ? path.posix : path.win32;
    for (const document of ['plan', 'overview'] as const) {
      it(`round trips ${document} in ${root} without losing feature casing`, () => {
        const target = { featureName: 'FeatureName', document };
        const doc = paths.join(root, '.hive', 'features', target.featureName, document === 'plan' ? 'plan.md' : 'context/overview.md');
        const comments = paths.join(root, '.hive', 'features', target.featureName, 'comments', `${document}.json`);
        expect(reviewDocumentPath(root, target)).toBe(doc);
        expect(reviewCommentsPath(root, target)).toBe(comments);
        expect(reviewTargetForDocument(root, doc)).toEqual(target);
        expect(reviewTargetForComments(root, comments)).toEqual(target);
        if (paths === path.win32) {
          expect(reviewTargetForDocument(root.toLowerCase(), doc)).toEqual(target);
          expect(reviewTargetForComments(root.toLowerCase(), comments)).toEqual(target);
        }
      });
    }
    it(`accepts only exact workspace routes in ${root}`, () => {
      const plan = '.hive/features/FeatureName/plan.md';
      const comments = '.hive/features/FeatureName/comments/plan.json';
      expect(reviewTargetForComments(root, paths.join(root, '.hive/features/FeatureName/comments.json')))
        .toEqual({ featureName: 'FeatureName', document: 'plan' });
      for (const [route, parse] of [[plan, reviewTargetForDocument], [comments, reviewTargetForComments]] as const) {
        for (const invalid of [paths.join(`${root}-sibling`, route), paths.join(root, 'nested', route), `${root}/../${route}`, `${root}/nested/../${route}`, paths.join(root, `${route}.bak`), route]) {
          expect(parse(root, invalid)).toBeNull();
        }
      }
      expect(reviewTargetForDocument(root, paths.join(root, '.hive/features/FeatureName/overview.md'))).toBeNull();
      expect(reviewTargetForDocument(root, paths.join(root, '.hive/features/FeatureName/context/other.md'))).toBeNull();
      expect(reviewTargetForComments(root, paths.join(root, '.hive/features/FeatureName/comments/other.json'))).toBeNull();
    });
  }

  it('reads canonical first, falls back only for plans, and always writes canonical', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-routing-'));
    try {
      const plan = { featureName: 'FeatureName', document: 'plan' } as const;
      const overview = { ...plan, document: 'overview' } as const;
      const canonical = reviewCommentsPath(root, plan);
      const legacy = path.join(root, '.hive/features/FeatureName/comments.json');
      expect(findReviewCommentsPath(root, plan)).toBeNull();
      expect(findReviewCommentsPath(root, overview)).toBeNull();
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(legacy, '{}');
      expect(findReviewCommentsPath(root, plan)).toBe(legacy);
      expect(findReviewCommentsPath(root, overview)).toBeNull();
      expect(reviewCommentsPath(root, plan)).toBe(canonical);
      fs.writeFileSync(canonical, '{}');
      fs.writeFileSync(reviewCommentsPath(root, overview), '{}');
      expect(findReviewCommentsPath(root, plan)).toBe(canonical);
      expect(findReviewCommentsPath(root, overview)).toBe(reviewCommentsPath(root, overview));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
