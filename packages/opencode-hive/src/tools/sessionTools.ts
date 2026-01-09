import { z } from 'zod';
import { SessionService } from '../services/sessionService.js';
import { FeatureService } from '../services/featureService.js';
import { TaskService } from '../services/taskService.js';
import { PlanService } from '../services/planService.js';
import { ContextService } from '../services/contextService.js';
import { detectContext } from '../utils/detection.js';

export function createSessionTools(projectRoot: string) {
  const sessionService = new SessionService(projectRoot);
  const featureService = new FeatureService(projectRoot);
  const taskService = new TaskService(projectRoot);
  const planService = new PlanService(projectRoot);
  const contextService = new ContextService(projectRoot);
  
  const getActiveFeature = (): string | null => {
    const ctx = detectContext(projectRoot);
    return ctx?.feature || null;
  };

  return {
    hive_session_open: {
      description: 'Open a Hive session for a feature or task. Returns full context needed to resume work.',
      parameters: z.object({
        feature: z.string().optional().describe('Feature name (defaults to active)'),
        task: z.string().optional().describe('Task folder to focus on'),
      }),
      execute: async ({ feature, task }: { feature?: string; task?: string }, toolContext: unknown) => {
        const featureName = feature || getActiveFeature();
        if (!featureName) return { error: 'No feature specified and no active feature' };

        const featureData = featureService.get(featureName);
        if (!featureData) return { error: `Feature '${featureName}' not found` };

          const ctx = toolContext as { sessionID?: string };
          if (ctx?.sessionID) {
            sessionService.track(featureName, ctx.sessionID, task);
          }

          const planResult = planService.read(featureName);
        const tasks = taskService.list(featureName);
        const contextCompiled = contextService.compile(featureName);
        const sessions = sessionService.list(featureName);

        const response: Record<string, unknown> = {
          feature: {
            name: featureData.name,
            status: featureData.status,
            ticket: featureData.ticket,
          },
          plan: planResult ? {
            content: planResult.content,
            commentCount: planResult.comments.length,
          } : null,
          tasks: tasks.map(t => ({
            folder: t.folder,
            name: t.name,
            status: t.status,
            origin: t.origin,
          })),
          context: contextCompiled || null,
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            taskFolder: s.taskFolder,
            isMaster: s.sessionId === sessionService.getMaster(featureName),
          })),
        };

        if (task) {
          const taskInfo = taskService.get(featureName, task);
          if (taskInfo) {
            response.focusedTask = taskInfo;
          }
        }

        return response;
      },
    },

    hive_session_list: {
      description: 'List all sessions for the active feature',
      parameters: z.object({}),
      execute: async () => {
        const feature = getActiveFeature();
        if (!feature) return { error: 'No active feature' };

        const sessions = sessionService.list(feature);
        const master = sessionService.getMaster(feature);

        return {
          feature,
          master,
          sessions: sessions.map(s => ({
            sessionId: s.sessionId,
            taskFolder: s.taskFolder,
            startedAt: s.startedAt,
            lastActiveAt: s.lastActiveAt,
            isMaster: s.sessionId === master,
          })),
        };
      },
    },
  };
}
