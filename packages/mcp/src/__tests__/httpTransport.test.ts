import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestDb } from "@aif/shared/server";

// Set up an in-memory test DB before importing the server (tools reach the DB
// through @aif/data → @aif/shared/server getDb).
const testDb = { current: createTestDb() };
vi.mock("@aif/shared/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared/server")>();
  return {
    ...actual,
    getDb: () => testDb.current,
  };
});

// Mock env to avoid shared env validation.
vi.mock("@aif/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/shared")>();
  return {
    ...actual,
    getEnv: () => ({
      API_BASE_URL: "http://localhost:3009",
      DATABASE_URL: ":memory:",
      PORT: 3009,
    }),
  };
});

// Import the handler from server.ts — NOT index.ts, which self-runs main().
const { createMcpHttpHandler, createToolContext } = await import("../server.js");

const env = {
  apiUrl: "http://localhost:3009",
  transport: "http" as const,
  httpPort: 0,
  rateLimitReadRpm: 120,
  rateLimitWriteRpm: 30,
  rateLimitReadBurst: 10,
  rateLimitWriteBurst: 5,
};

/** POST a JSON-RPC `initialize` with the headers the SDK requires (else 406). */
function initialize(port: number): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The SDK returns 406 unless the client accepts BOTH content types.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.0" },
      },
    }),
  });
}

/** Read a JSON-RPC payload from either a JSON or an SSE (`data:`) response. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
    }
  }
  return null;
}

describe("MCP HTTP transport", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const context = createToolContext(env);
    server = createServer(createMcpHttpHandler(env, context));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves /health for Docker healthchecks", async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("lets two independent clients initialize without -32600", async () => {
    // The core regression: with a single shared stateful transport the second
    // initialize returned -32600 "Server already initialized". Stateless
    // per-request transports let every client initialize independently.
    const res1 = await initialize(port);
    const body1 = await readJsonRpc(res1);
    const res2 = await initialize(port);
    const body2 = await readJsonRpc(res2);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((body1?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect((body2?.error as { code?: number } | undefined)?.code).not.toBe(-32600);
    expect(body1?.result).toBeDefined();
    expect(body2?.result).toBeDefined();
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("createToolContext builds one stateful, shared RateLimiter", () => {
    // The handler closes over a single context, so every per-request server
    // shares this limiter. If it were rebuilt per request the bucket would
    // reset and rate limiting would silently break — so assert the bucket
    // accumulates state across calls.
    const context = createToolContext(env);
    for (let i = 0; i < env.rateLimitReadBurst; i++) {
      expect(context.rateLimiter.check("listTasks", "read")).toBe(true);
    }
    expect(context.rateLimiter.check("listTasks", "read")).toBe(false);
  });
});
