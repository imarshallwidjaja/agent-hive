import { tool } from "@opencode-ai/plugin";
import { FeatureService } from "../services/featureService.js";
import { PlanService } from "../services/planService.js";

export function createPlanReadTool(
  planService: PlanService,
  featureService: FeatureService
) {
  return tool({
    description: "Read current plan with optional comments for agent revision",
    args: {
      featureName: tool.schema.string().optional().describe("Feature name (defaults to active)"),
      includeComments: tool.schema.boolean().optional().describe("Include unresolved comments"),
    },
    async execute({ featureName, includeComments }) {
      const name = featureName || await featureService.assertActive();

      const plan = await planService.getPlan(name);
      if (!plan) {
        return JSON.stringify({
          error: "no-plan",
          message: `No plan exists for feature "${name}". Use hive_plan_generate first.`,
        });
      }

      const result: Record<string, unknown> = {
        plan: plan.content,
        version: plan.version,
        status: plan.status,
        lastUpdatedAt: plan.lastUpdatedAt,
      };

      if (includeComments) {
        result.unresolvedComments = [];
      }

      return JSON.stringify(result, null, 2);
    },
  });
}

export function createPlanUpdateTool(
  planService: PlanService,
  featureService: FeatureService
) {
  return tool({
    description: "Update plan after addressing comments",
    args: {
      featureName: tool.schema.string().optional().describe("Feature name (defaults to active)"),
      content: tool.schema.string().describe("New plan.md content"),
    },
    async execute({ featureName, content }) {
      const name = featureName || await featureService.assertActive();

      const result = await planService.savePlan(name, content, { incrementVersion: true });

      return JSON.stringify({
        version: result.version,
        path: result.path,
        status: "draft",
      });
    },
  });
}

export function createPlanApproveTool(
  planService: PlanService,
  featureService: FeatureService
) {
  return tool({
    description: "Mark plan as approved (typically called by VSCode, not agent)",
    args: {
      featureName: tool.schema.string().optional().describe("Feature name (defaults to active)"),
    },
    async execute({ featureName }) {
      const name = featureName || await featureService.assertActive();

      const result = await planService.approve(name);

      return JSON.stringify({
        approved: result.approved,
        version: result.version,
        message: "Plan approved. Ready for execution.",
      });
    },
  });
}

export function createPlanLockTool(
  planService: PlanService,
  featureService: FeatureService
) {
  return tool({
    description: "Lock plan when execution starts (prevents further edits)",
    args: {
      featureName: tool.schema.string().optional().describe("Feature name (defaults to active)"),
    },
    async execute({ featureName }) {
      const name = featureName || await featureService.assertActive();

      await planService.lock(name);

      return JSON.stringify({
        locked: true,
        message: "Plan is now locked. No further edits allowed during execution.",
      });
    },
  });
}
