import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "./configService";

describe("ConfigService", () => {
  it("normalizes agent variants", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-config-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    process.env.HOME = tempDir;
    delete process.env.USERPROFILE;

    try {
      const configDir = path.join(tempDir, ".config", "opencode");
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, "agent_hive.json");

      const cases: Array<{
        label: string;
        config: Record<string, unknown>;
        expected: string | undefined;
      }> = [
        { label: "missing", config: {}, expected: undefined },
        { label: "whitespace", config: { variant: "   " }, expected: undefined },
        { label: "trimmed", config: { variant: "  high  " }, expected: "high" },
        { label: "non-string", config: { variant: 123 }, expected: undefined },
      ];

      for (const testCase of cases) {
        const config = {
          agents: {
            hive: testCase.config,
          },
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        const service = new ConfigService();
        const result = service.getAgentConfig("hive");
        expect(result.variant, testCase.label).toBe(testCase.expected);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  });
});
