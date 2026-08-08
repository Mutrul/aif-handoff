import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRepositoriesMock = vi.fn();

vi.mock("@aif/data", () => ({
  appendTaskActivityLog: vi.fn(),
  findGitHubIssueByTaskId: vi.fn(),
  findTaskById: vi.fn(),
  listEnabledGitHubRepositories: (...args: unknown[]) => listRepositoriesMock(...args),
}));

vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return { ...actual, getEnv: () => actual.validateEnv(process.env) };
});

vi.mock("../autoQueueCommit.js", () => ({ ensureAutoQueueTaskCommit: vi.fn() }));

const { synchronizeGitHubProjects } = await import("../githubWorkflow.js");

describe("GitHub workflow synchronization", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("API_BASE_URL", "http://localhost:3999");
    listRepositoriesMock.mockReturnValue([
      { projectId: "project-1", lastSyncedAt: null },
      { projectId: "project-2", lastSyncedAt: "2026-08-08T09:59:40.000Z" },
    ]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("syncs due repositories once per interval", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as typeof fetch;

    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:00.000Z"));
    await synchronizeGitHubProjects(Date.parse("2026-08-08T10:00:10.000Z"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3999/projects/project-1/github/sync",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
});
