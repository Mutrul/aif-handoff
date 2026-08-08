import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { projects } from "@aif/shared";
import { createTestDb } from "@aif/shared/server";

const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return { ...actual, getDb: () => testDb.current };
});

const { githubRouter } = await import("../routes/github.js");
const { GitHubClient, issueIsEligible } = await import("../services/github.js");
const { importGitHubIssueTask, upsertGitHubRepository } = await import("@aif/data");

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  testDb.current = createTestDb();
  testDb.current
    .insert(projects)
    .values({ id: "project-1", name: "Repo", rootPath: "/tmp/repo" })
    .run();
  vi.stubEnv("GITHUB_TEST_TOKEN", "secret-token");
  vi.restoreAllMocks();
});

describe("GitHub client", () => {
  it("classifies rate limits from structured HTTP fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { message: "limit" },
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "2000000000",
            },
          },
        ),
      ),
    );

    await expect(new GitHubClient("secret").getRepository("owner", "repo")).rejects.toMatchObject({
      httpStatus: 403,
      adapterCode: "rate_limited",
    });
  });

  it("applies label, assignee, and milestone eligibility", () => {
    expect(
      issueIsEligible(
        {
          number: 1,
          node_id: "I_1",
          html_url: "https://github.com/o/r/issues/1",
          state: "open",
          title: "Task",
          body: "",
          user: { login: "author" },
          labels: [{ name: "aif" }],
          assignees: [{ login: "bot" }],
          milestone: { title: "v1" },
          comments: 0,
          updated_at: "2026-08-08T00:00:00Z",
        },
        { labels: ["aif"], assignee: "bot", milestone: "v1" },
      ),
    ).toBe(true);
  });
});

describe("GitHub project routes", () => {
  it("connects a repository and performs an idempotent empty sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          name: "repo",
          full_name: "owner/repo",
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          owner: { login: "owner" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);

    const connected = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository: "owner/repo",
        tokenEnvVar: "GITHUB_TEST_TOKEN",
        enabled: true,
        eligibility: { labels: ["aif"], assignee: null, milestone: null },
      }),
    });
    expect(connected.status).toBe(200);
    expect(await connected.json()).toMatchObject({
      owner: "owner",
      name: "repo",
      tokenConfigured: true,
    });

    const synced = await app.request("/projects/project-1/github/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ imported: 0, updated: 0, skipped: 0 });
  });

  it("rejects a connection when its credential environment variable is absent", async () => {
    vi.stubEnv("GITHUB_MISSING_TOKEN", "");
    const app = new Hono();
    app.route("/projects", githubRouter);
    const response = await app.request("/projects/project-1/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "owner/repo", tokenEnvVar: "GITHUB_MISSING_TOKEN" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "github_authentication" });
  });

  it("creates one pull request and reuses it on repeated publication", async () => {
    upsertGitHubRepository({
      projectId: "project-1",
      owner: "owner",
      name: "repo",
      htmlUrl: "https://github.com/owner/repo",
      defaultBranch: "main",
      tokenEnvVar: "GITHUB_TEST_TOKEN",
      eligibility: { labels: [], assignee: null, milestone: null },
      enabled: true,
    });
    const imported = importGitHubIssueTask({
      projectId: "project-1",
      owner: "owner",
      repository: "repo",
      issueNumber: 154,
      nodeId: "I_154",
      htmlUrl: "https://github.com/owner/repo/issues/154",
      state: "open",
      sourceUpdatedAt: "2026-08-08T00:00:00Z",
      snapshot: {
        title: "GitHub mode",
        body: "Implement it",
        author: "author",
        labels: [],
        assignees: [],
        milestone: null,
        comments: [],
      },
    });
    const pull = {
      number: 200,
      html_url: "https://github.com/owner/repo/pull/200",
      state: "open",
      merged_at: null,
      head: { sha: "0123456789abcdef" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ state: "success" }))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse(pull))
      .mockResolvedValueOnce(jsonResponse({ state: "success" }));
    vi.stubGlobal("fetch", fetchMock);
    const app = new Hono();
    app.route("/projects", githubRouter);
    const publish = () =>
      app.request(`/projects/project-1/github/tasks/${imported.taskId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: "feature/github-issue-154",
          commitSha: "0123456789abcdef",
          implementationLog: "Implemented",
          reviewComments: "Automated review passed",
        }),
      });

    expect(await (await publish()).json()).toMatchObject({ prNumber: 200, prState: "open" });
    expect(await (await publish()).json()).toMatchObject({ prNumber: 200, prState: "open" });
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/pulls") && init?.method === "POST",
    );
    const commentCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/issues/200/comments") && init?.method === "POST",
    );
    expect(createCalls).toHaveLength(1);
    expect(commentCalls).toHaveLength(1);
  });
});
