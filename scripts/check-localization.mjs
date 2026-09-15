#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogs } from "../packages/core/src/localization/validation.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories = process.argv.slice(2);
if (directories.length === 0)
  directories.push("src/localization", "apps/chrome-extension/src/localization");
let failed = false;
for (const directory of directories) {
  const absolute = path.resolve(root, directory);
  const catalogs = {};
  for (const file of (await fs.readdir(absolute)).filter((name) => name.endsWith(".json"))) {
    catalogs[file.slice(0, -5)] = JSON.parse(await fs.readFile(path.join(absolute, file), "utf8"));
  }
  if (!catalogs.en) throw new Error(`${directory}: Missing English base catalog`);
  const errors = validateCatalogs(catalogs.en, catalogs);
  for (const error of errors) console.error(`${directory}/${error}`);
  failed ||= errors.length > 0;
  if (!errors.length)
    console.log(
      `${directory}: ${Object.keys(catalogs).length} catalogs, ${Object.keys(catalogs.en).length} keys, complete`,
    );
}
process.exitCode = failed ? 1 : 0;
