import { describe, expect, it } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Behavioral verification of Co-Authored-By suppression — observes the *generated
 * commit content*, not just the intermediate options object (requested in PR #162 review).
 *
 * Gated: requires a real, authenticated `claude` on PATH AND
 * `AIF_CLAUDE_INTEGRATION=1`. CI does not satisfy this, so the main suite stays
 * hermetic. Run locally with:
 *   AIF_CLAUDE_INTEGRATION=1 npx vitest run claudeAttribution.integration.test.ts
 *
 * Note: in the Agent SDK + Bash-commit path the Co-Authored-By trailer is not
 * injected regardless of attribution; this test therefore guards the observed
 * end state (agent commits carry no Co-Authored-By) under the adapter's default
 * suppression settings `{ attribution: { commit: "", pr: "" } }`.
 */
const ENABLED = process.env.AIF_CLAUDE_INTEGRATION === "1";

describe.skipIf(!ENABLED)("Claude attribution — generated commit content (integration)", () => {
  it("produces a commit with no Co-Authored-By trailer under the suppression settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-attr-int-"));
    try {
      execSync("git init -q -b main", { cwd: dir });
      execSync('git config user.email "int@test.local"', { cwd: dir });
      execSync('git config user.name "int"', { cwd: dir });
      writeFileSync(join(dir, "hello.txt"), "test\n");
      execSync("git add hello.txt", { cwd: dir });

      let result: { subtype?: string } | null = null;
      const stream = query({
        prompt:
          "There is one staged file. Run a git commit with exactly this message and nothing else: add hello",
        options: {
          cwd: dir,
          // The adapter's default suppression settings (see buildClaudeQueryOptions).
          settings: { attribution: { commit: "", pr: "" } },
          settingSources: ["project"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });
      for await (const event of stream) {
        if (event.type === "result") result = event as { subtype?: string };
      }

      expect(result?.subtype).toBe("success");
      const body = execSync("git log -1 --format=%B", { cwd: dir, encoding: "utf8" });
      expect(/co-authored-by/i.test(body)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
