import { describe, expect, it } from 'bun:test';
import { assembleLiveContextCatalogs, LIVE_CONTEXT_CATALOG_MARKER } from './context-catalog.js';

describe('assembleLiveContextCatalogs', () => {
  it('delivers both scopes within the shared byte budget without bodies', () => {
    const calls: unknown[] = [];
    const result = assembleLiveContextCatalogs({
      readCatalog(scope, options) {
        calls.push({ scope, options });
        return {
          scope,
          revision: 1,
          snapshot: 'snapshot',
          files: [{
            name: scope.type === 'project' ? 'project-note' : 'feature-note',
            updatedAt: '2026-09-13T00:00:00.000Z',
            role: 'durable',
            includeInExecution: true,
            includeInNetwork: true,
            description: 'Metadata only',
          }],
          complete: true,
          diagnostics: [],
        } as any;
      },
    }, [{ type: 'project' }, { type: 'feature', featureName: 'feature' }]);

    expect(result.text).toStartWith(LIVE_CONTEXT_CATALOG_MARKER);
    expect(result.bytes).toBeLessThanOrEqual(8 * 1024);
    expect(result.text).toContain('project-note');
    expect(result.text).toContain('feature-note');
    expect(result.text).not.toContain('document body');
    expect(calls).toHaveLength(2);
  });

  it('reports current storage errors explicitly', () => {
    const result = assembleLiveContextCatalogs({
      readCatalog() {
        throw Object.assign(new Error('repair index'), { reason: 'context_index_invalid' });
      },
    }, [{ type: 'project' }]);

    expect(result.text).toContain('context_index_invalid');
    expect(result.text).toContain('repair index');
  });

  it('bounds an oversized scope failure without denying the other scope', () => {
    const result = assembleLiveContextCatalogs({
      readCatalog(scope) {
        if (scope.type === 'project') {
          throw Object.assign(new Error('x'.repeat(16 * 1024)), {
            reason: 'context_inventory_too_large',
            details: { inventory: 'y'.repeat(16 * 1024) },
          });
        }
        return {
          scope,
          revision: 1,
          snapshot: 'snapshot',
          files: [],
          complete: true,
          diagnostics: [],
        } as any;
      },
    }, [{ type: 'project' }, { type: 'feature', featureName: 'feature' }]);

    expect(result.bytes).toBeLessThanOrEqual(8 * 1024);
    const payload = JSON.parse(result.text.slice(result.text.indexOf('\n') + 1));
    expect(payload.catalogs).toHaveLength(2);
    expect(payload.catalogs[0]).toMatchObject({
      scope: { type: 'project' },
      status: 'unavailable',
      reason: 'context_response_too_large',
    });
    expect(payload.catalogs[1]).toMatchObject({
      scope: { type: 'feature', featureName: 'feature' },
      status: 'available',
    });
  });
});
