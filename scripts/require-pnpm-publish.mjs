#!/usr/bin/env node

const userAgent = process.env.npm_config_user_agent || "";
const execPath = process.env.npm_execpath || "";

if (userAgent.includes("pnpm/") || execPath.includes("pnpm")) {
  process.exit(0);
}

console.error("Refusing to publish with npm: use pnpm publish so workspace:* deps are rewritten.");
process.exit(1);
