import { tool } from "@opencode-ai/plugin";
import type { StepWithFolder, BatchInfo, PlanJson } from "../types.js";
import { FeatureService } from "../services/featureService.js";
import { StepService } from "../services/stepService.js";
import { DecisionService, type Decision } from "../services/decisionService.js";
import { PlanService } from "../services/planService.js";
import { getFeaturePath, getProblemPath } from "../utils/paths.js";
import { readFile } from "../utils/json.js";

function getStatusIcon(status: string): string {
  return status === "draft" ? "🔄" : status === "approved" ? "✅" : "🔒";
}

function extractFilesFromSpec(spec: string): string[] {
  const files: string[] = [];
  const patterns = [
    /`([^`]+\.[a-z]{2,4})`/gi,
    /(?:^|\s)([\w./]+\.[a-z]{2,4})(?:\s|$|,)/gim,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(spec)) !== null) {
      const file = match[1];
      if (file && !files.includes(file) && !file.startsWith("http")) {
        files.push(file);
      }
    }
  }
  
  return files.slice(0, 5);
}

function extractDescriptionFromSpec(spec: string): string {
  const lines = spec.split("\n");
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-") && !trimmed.startsWith("```")) {
      return trimmed.slice(0, 100) + (trimmed.length > 100 ? "..." : "");
    }
  }
  
  return "(no description)";
}

export function createPlanGenerateTool(
  planService: PlanService,
  featureService: FeatureService,
  stepService: StepService,
  decisionService: DecisionService
) {
  return tool({
    description: "Generate plan.md from steps and decisions for the active feature",
    args: {
      featureName: tool.schema.string().optional().describe("Feature name (defaults to active)"),
    },
    async execute({ featureName }) {
      const name = featureName || await featureService.assertActive();
      
      const feature = await featureService.get(name);
      if (!feature) {
        throw new Error(`Feature "${name}" not found`);
      }

      let summary = `Implement ${name}`;
      try {
        const featurePath = getFeaturePath(planService["directory"], name);
        const problemContent = await readFile(getProblemPath(featurePath));
        if (problemContent) {
          summary = problemContent.split("\n").find(l => l.trim()) || summary;
        }
      } catch {}

      const planJson = await planService.generatePlanJson(name, summary);
      const markdown = planService.planJsonToMarkdown(planJson);

      return JSON.stringify({
        path: planService.getJsonPlanPath(name),
        version: planJson.version,
        status: planJson.status,
      });
    },
  });
}
