import { SessionService } from 'hive-core';
import type { ToolRegistration } from './base';

export function getSessionTools(workspaceRoot: string): ToolRegistration[] {
  const sessionService = new SessionService(workspaceRoot);

  return [
    {
      name: 'hive_session_open',
      displayName: 'Open Hive Session',
      modelDescription: 'Open a session and get full feature context. Returns plan, tasks, context files, and session history. Use at the start of work to understand current state.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature name' },
          task: { type: 'string', description: 'Optional task to focus on' },
        },
        required: ['feature'],
      },
      invoke: async (input) => {
        const { feature, task } = input as { feature: string; task?: string };
        const sessionId = `session_${Date.now()}`;
        const session = sessionService.track(feature, sessionId, task);
        const sessions = sessionService.list(feature);
        return JSON.stringify({
          sessionId: session.sessionId,
          feature,
          task,
          activeSessions: sessions.length,
          master: sessionService.getMaster(feature),
        });
      },
    },
    {
      name: 'hive_session_list',
      displayName: 'List Sessions',
      modelDescription: 'List all sessions for a feature. Shows active and past sessions to understand who else is working.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          feature: { type: 'string', description: 'Feature name' },
        },
        required: ['feature'],
      },
      invoke: async (input) => {
        const { feature } = input as { feature: string };
        const sessions = sessionService.list(feature);
        const master = sessionService.getMaster(feature);
        return JSON.stringify({ sessions, master });
      },
    },
  ];
}
