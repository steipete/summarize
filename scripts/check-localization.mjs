#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableUiLocales } from "../packages/core/src/localization/messages.ts";
import { validateCatalogs } from "../packages/core/src/localization/validation.ts";
import { inspectMessageUsage, inspectHtml, inspectSource } from "./localization-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv.slice(2);
const directories = requested.length
  ? requested
  : [
      "packages/core/src/localization/catalogs",
      "src/localization",
      "apps/chrome-extension/src/localization",
    ];
const errors = [];
const groups = [];
for (const directory of directories) {
  const absolute = path.resolve(root, directory);
  const catalogs = {};
  for (const file of (await fs.readdir(absolute)).filter((name) => name.endsWith(".json")).sort()) {
    catalogs[file.slice(0, -5)] = JSON.parse(await fs.readFile(path.join(absolute, file), "utf8"));
  }
  if (!catalogs.en) throw new Error(`${directory}: Missing English base catalog`);
  if (!requested.length) {
    for (const locale of availableUiLocales)
      if (!Object.hasOwn(catalogs, locale))
        errors.push(`${directory}/${locale}.json: Missing locale catalog`);
    for (const locale of Object.keys(catalogs))
      if (!availableUiLocales.includes(locale))
        errors.push(`${directory}/${locale}.json: Unregistered locale catalog`);
  }
  errors.push(...validateCatalogs(catalogs.en, catalogs).map((error) => `${directory}/${error}`));
  groups.push({ directory, catalogs, keys: new Set(Object.keys(catalogs.en)) });
}

if (!requested.length) {
  const [shared, cli, extension] = groups;
  for (const surface of [cli, extension]) {
    for (const key of surface.keys)
      if (shared.keys.has(key))
        errors.push(`${surface.directory}/en:${key}: Duplicates a shared key`);
  }
  const usedCli = new Set();
  const usedExtension = new Set();
  const usedCore = new Set();
  for (const directory of ["src", "packages/core/src", "apps/chrome-extension/src"]) {
    const surfaceKeys =
      directory === "src"
        ? cli.keys
        : directory === "apps/chrome-extension/src"
          ? extension.keys
          : new Set();
    for await (const relative of fs.glob(`${directory}/**/*.{ts,tsx,html}`, { cwd: root })) {
      const source = await fs.readFile(path.join(root, relative), "utf8");
      const { keys, unknown } = inspectMessageUsage(relative, source, shared.keys, surfaceKeys);
      const used =
        directory === "src"
          ? usedCli
          : directory === "packages/core/src"
            ? usedCore
            : usedExtension;
      for (const key of keys) {
        used.add(key);
      }
      errors.push(
        ...unknown.map((key) => `${relative}: Message key ${key} is not available on this surface`),
      );
      // Core has no UI: its public diagnostics and model instructions remain API data.
      if (directory === "packages/core/src") continue;
      // Audit all display sinks; also audit copy constants in options, panel, and UI components.
      const strict =
        /^apps\/chrome-extension\/src\/(?:ui\/|entrypoints\/(?:sidepanel|options)\/)/u.test(
          relative,
        ) ||
        /^src\/(?:flags|config|llm\/model-id|application\/[^/]+|daemon\/(?:cli(?:-[\w-]+)?|systemd|launchd|schtasks|command)|run\/(?:help|cli-preflight|cli-summarize-command|runner-setup|run-settings-parse|status-cli|slides-cli|transcriber-cli))\.ts$/u.test(
          relative,
        );
      const findings = relative.endsWith(".html")
        ? inspectHtml(source)
        : inspectSource(relative, source, { strict });
      errors.push(
        ...findings.map(
          ({ line, text }) =>
            `${relative}:${line}: Uncatalogued interface text ${JSON.stringify(text)}`,
        ),
      );
    }
  }
  for (const [group, used] of [
    [shared, new Set([...usedCli, ...usedExtension, ...usedCore])],
    [cli, usedCli],
    [extension, usedExtension],
  ]) {
    for (const key of group.keys)
      if (!used.has(key)) errors.push(`${group.directory}/en:${key}: Unused key`);
  }
}

for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
else
  for (const { directory, catalogs, keys } of groups)
    console.log(
      `${directory}: ${Object.keys(catalogs).length} catalogs, ${keys.size} keys, complete`,
    );
