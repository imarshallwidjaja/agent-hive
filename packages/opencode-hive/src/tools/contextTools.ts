import { z } from 'zod';
import { ContextService } from '../services/contextService.js';
import { FeatureService } from '../services/featureService.js';
import { detectContext } from '../utils/detection.js';

export function createContextTools(projectRoot: string) {
  const contextService = new ContextService(projectRoot);
  const featureService = new FeatureService(projectRoot);
  
  const getActiveFeature = (): string | null => {
    const ctx = detectContext(projectRoot);
    return ctx?.feature || null;
  };

  return {
    hive_context_write: {
      description: 'Write a context file for the active feature. Context files store persistent notes, decisions, and reference material.',
      parameters: z.object({
        name: z.string().describe('Context file name (e.g., "architecture", "decisions", "notes")'),
        content: z.string().describe('Markdown content to write'),
      }),
      execute: async ({ name, content }: { name: string; content: string }) => {
        const feature = getActiveFeature();
        if (!feature) return { error: 'No active feature' };

        const filePath = contextService.write(feature, name, content);
        return { success: true, path: filePath };
      },
    },

    hive_context_read: {
      description: 'Read a specific context file or all context for the active feature',
      parameters: z.object({
        name: z.string().optional().describe('Context file name. If omitted, returns all context compiled.'),
      }),
      execute: async ({ name }: { name?: string }) => {
        const feature = getActiveFeature();
        if (!feature) return { error: 'No active feature' };

        if (name) {
          const content = contextService.read(feature, name);
          if (!content) return { error: `Context file '${name}' not found` };
          return { name, content };
        }

        const compiled = contextService.compile(feature);
        if (!compiled) return { message: 'No context files found' };
        return { compiled };
      },
    },

    hive_context_list: {
      description: 'List all context files for the active feature',
      parameters: z.object({}),
      execute: async () => {
        const feature = getActiveFeature();
        if (!feature) return { error: 'No active feature' };

        const files = contextService.list(feature);
        if (files.length === 0) return { files: [], message: 'No context files' };

        return {
          files: files.map(f => ({
            name: f.name,
            updatedAt: f.updatedAt,
            previewLength: f.content.length,
          })),
        };
      },
    },

    hive_context_delete: {
      description: 'Delete a context file',
      parameters: z.object({
        name: z.string().describe('Context file name to delete'),
      }),
      execute: async ({ name }: { name: string }) => {
        const feature = getActiveFeature();
        if (!feature) return { error: 'No active feature' };

        const deleted = contextService.delete(feature, name);
        if (!deleted) return { error: `Context file '${name}' not found` };
        return { success: true, deleted: name };
      },
    },
  };
}
