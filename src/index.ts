#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { scheduler } from "./events/scheduler.js";
import { session } from "./browser/session.js";
import { ensureDataDir } from "./config.js";

async function main(): Promise<void> {
  ensureDataDir();

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Begin monitoring any previously-saved searches. The browser launches lazily
  // on the first poll / tool call, so startup stays fast.
  scheduler.start();

  const shutdown = async () => {
    scheduler.stopAll();
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stderr is safe for logs; stdout is reserved for the MCP JSON-RPC stream.
  console.error("[upwork-mcp] ready (stdio).");
}

main().catch((err) => {
  console.error("[upwork-mcp] fatal:", err);
  process.exit(1);
});
