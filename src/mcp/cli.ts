#!/usr/bin/env node
/**
 * MCP server entry point for summarize.
 *
 * Usage:
 *   npx @steipete/summarize mcp
 *   node dist/esm/mcp/cli.js
 *
 * Or in Claude Code / MCP client config:
 *   { "command": "npx", "args": ["-y", "@steipete/summarize", "mcp"] }
 */

import { runMcpServer } from "./server.js";

runMcpServer().catch((error) => {
  // stderr only — stdout is reserved for JSON-RPC
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`summarize-mcp fatal: ${message}\n`);
  process.exit(1);
});
