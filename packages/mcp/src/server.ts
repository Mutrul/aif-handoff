import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "@aif/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpEnv } from "./env.js";
import { RateLimiter } from "./middleware/rateLimit.js";
import type { ToolContext } from "./tools/index.js";
import { register as registerListTasks } from "./tools/listTasks.js";
import { register as registerGetTask } from "./tools/getTask.js";
import { register as registerSearchTasks } from "./tools/searchTasks.js";
import { register as registerListProjects } from "./tools/listProjects.js";
import { register as registerCreateTask } from "./tools/createTask.js";
import { register as registerUpdateTask } from "./tools/updateTask.js";
import { register as registerSyncStatus } from "./tools/syncStatus.js";
import { register as registerPushPlan } from "./tools/pushPlan.js";
import { register as registerAnnotatePlan } from "./tools/annotatePlan.js";

const log = logger("mcp");

/**
 * Build the shared tool context (rate limiter) once at startup.
 *
 * In HTTP mode a fresh {@link McpServer} is created per request, but every
 * request MUST share this context: the {@link RateLimiter} keeps stateful
 * in-memory token buckets, so rebuilding it per request would reset the buckets
 * and silently disable rate limiting.
 */
export function createToolContext(env: McpEnv): ToolContext {
  const rateLimiter = new RateLimiter(
    { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
    { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
  );

  log.debug(
    {
      read: { rpm: env.rateLimitReadRpm, burst: env.rateLimitReadBurst },
      write: { rpm: env.rateLimitWriteRpm, burst: env.rateLimitWriteBurst },
    },
    "Shared tool context created",
  );

  return { rateLimiter };
}

/**
 * Create an {@link McpServer} and register all tools against the shared context.
 * Cheap to call — safe to invoke per request in stateless HTTP mode.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: "handoff-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register read-only tools
  registerListTasks(server, context);
  registerGetTask(server, context);
  registerSearchTasks(server, context);
  registerListProjects(server, context);

  // Register write tools
  registerCreateTask(server, context);
  registerUpdateTask(server, context);
  registerSyncStatus(server, context);
  registerPushPlan(server, context);
  registerAnnotatePlan(server, context);

  return server;
}

/**
 * Build the Node HTTP request handler. Exposed (with the factories above) for
 * tests so routing + transport wiring can be exercised without binding a port
 * or importing the process entry (`index.ts` self-runs `main()` on import).
 */
export function createMcpHttpHandler(env: McpEnv, context: ToolContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://localhost:${env.httpPort}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url.pathname === "/mcp") {
      log.debug({ method: req.method }, "MCP request received");

      // Stateless mode: a StreamableHTTPServerTransport with no sessionIdGenerator
      // handles exactly ONE request, so a fresh server + transport is created per
      // request. This lets every client (each Claude Code window) initialize
      // independently instead of colliding on a single shared stateful session
      // (which returned -32600 "Server already initialized" for the 2nd client).
      // Server->client events do not travel through this transport — they are
      // pushed via the API broadcast endpoint — so no session tracking is needed.
      const server = createMcpServer(context);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        log.debug("MCP request closed — tearing down per-request server/transport");
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        log.error(
          { error: error instanceof Error ? error.message : String(error) },
          "MCP request handling failed",
        );
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  };
}

export { loadMcpEnv } from "./env.js";
export { RateLimiter } from "./middleware/rateLimit.js";
export { toMcpError, rateLimitError, validationError } from "./middleware/errorHandler.js";
export type { ToolContext, ToolRegistrar } from "./tools/index.js";
