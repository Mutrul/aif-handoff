import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dockerfile = readFileSync(resolve(repositoryRoot, ".docker/Dockerfile"), "utf8");
const developmentCompose = readFileSync(resolve(repositoryRoot, "docker-compose.yml"), "utf8");
const productionCompose = readFileSync(
  resolve(repositoryRoot, "docker-compose.production.yml"),
  "utf8",
);
const runtimePackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, "packages/runtime/package.json"), "utf8"),
) as { dependencies: Record<string, string> };

describe("Docker Codex version resolution", () => {
  it("resolves the SDK from the configured npm selector during the build", () => {
    expect(runtimePackage.dependencies["@openai/codex-sdk"]).toBe("*");
    expect(dockerfile).toContain("ARG CODEX_VERSION=latest");
    expect(dockerfile).toContain('"@openai/codex-sdk@${CODEX_VERSION}"');
    expect(dockerfile).toContain("--prefix /opt/codex");
    expect(dockerfile).toContain("--package-lock=false");
    expect(dockerfile).toContain(
      "COPY --from=codex /opt/codex/node_modules/@openai ./node_modules/@openai",
    );
    expect(dockerfile).toContain("npm ci --ignore-scripts");
    const protocolGeneration = dockerfile.indexOf(
      "npm run codex:app-server:protocol:generate --workspace=@aif/runtime",
    );
    const applicationBuild = dockerfile.indexOf("npx turbo build");
    expect(protocolGeneration).toBeGreaterThan(-1);
    expect(protocolGeneration).toBeLessThan(applicationBuild);
  });

  it("uses the CLI shipped with the selected SDK", () => {
    expect(dockerfile).toContain("CODEX_CLI_PATH=/app/node_modules/.bin/codex");
    expect(dockerfile).toContain("PATH=/app/node_modules/.bin:${PATH}");
    expect(dockerfile).not.toMatch(/npm i -g [^\n]*@openai\/codex/);
  });

  it.each([
    ["development", developmentCompose],
    ["production", productionCompose],
  ])("passes CODEX_VERSION through every %s image build", (_name, compose) => {
    expect(compose.match(/CODEX_VERSION: \$\{CODEX_VERSION:-latest\}/g)).toHaveLength(4);
  });
});
