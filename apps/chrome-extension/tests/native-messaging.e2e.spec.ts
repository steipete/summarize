import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import { NATIVE_MESSAGING_HOST_NAME } from "../../../src/daemon/constants.js";
import { buildNativeMessagingManifest } from "../../../src/daemon/native-messaging-install.js";
import {
  buildUiState,
  closeExtension,
  getExtensionUrl,
  getExtensionPath,
  seedSettings,
  sendBgMessage,
  trackErrors,
  waitForPanelPort,
  type ExtensionHarness,
} from "./helpers/extension-harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

test.skip(
  process.env.SUMMARIZE_E2E_HTTP_TRANSPORT === "1",
  "Native Messaging E2E requires the production transport build.",
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("Missing server address"));
      else resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

type NativeMessagingHarness = ExtensionHarness & { nativeManifestPaths: string[] };

async function launchNativeMessagingHarness(port: number): Promise<NativeMessagingHarness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-native-home-"));
  const extensionPath = path.join(home, "extension");
  fs.cpSync(getExtensionPath("chromium"), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    permissions?: string[];
    optional_permissions?: string[];
  };
  manifest.permissions = [...(manifest.permissions ?? []), "nativeMessaging"];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter(
    (permission) => permission !== "nativeMessaging",
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const extensionId = Array.from(
    createHash("sha256").update(fs.realpathSync(extensionPath)).digest("hex").slice(0, 32),
    (character) => String.fromCharCode(97 + Number.parseInt(character, 16)),
  ).join("");

  const configDir = path.join(home, ".summarize");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "daemon.json"),
    `${JSON.stringify({
      version: 2,
      token: "native-e2e-token",
      tokens: ["native-e2e-token"],
      port,
      env: {},
      installedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );

  const launcherPath = path.join(configDir, "native-host-e2e");
  const userDataDir = path.join(home, "profile");
  const registerPath = path.join(repoRoot, "scripts", "register-typescript.mjs");
  const cliPath = path.join(repoRoot, "src", "cli.ts");
  const command = [
    "/usr/bin/env",
    `HOME=${home}`,
    process.execPath,
    "--import",
    registerPath,
    cliPath,
    "daemon",
    "native-host",
    "--extension-id",
    extensionId,
  ]
    .map(shellQuote)
    .join(" ");
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700 });

  const nativeManifestDirs = [path.join(userDataDir, "NativeMessagingHosts")];
  const nativeManifestPaths = nativeManifestDirs.map((directory) => {
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${NATIVE_MESSAGING_HOST_NAME}.json`);
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite native host: ${target}`);
    fs.writeFileSync(
      target,
      `${JSON.stringify(buildNativeMessagingManifest({ launcherPath, extensionId }), null, 2)}\n`,
    );
    return target;
  });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    env: { ...process.env, HOME: home },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const background =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
  expect(new URL(background.url()).host).toBe(extensionId);

  return {
    context,
    extensionId,
    pageErrors: [],
    consoleErrors: [],
    userDataDir: home,
    browser: "chromium",
    nativeManifestPaths,
  };
}

test("installed native host carries status, models, and summary streaming end to end", async () => {
  const seen: Array<{ method: string; url: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      authorization: request.headers.authorization,
    });
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, version: "native-e2e" }));
      return;
    }
    if (request.url === "/v1/ping") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          options: [{ id: "native/e2e", label: "Through native host" }],
          providers: {},
        }),
      );
      return;
    }
    if (request.url === "/v1/summarize/native-run/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: chunk\ndata: {"text":"Native "}\n\n');
      setTimeout(() => {
        response.end('event: chunk\ndata: {"text":"summary"}\n\nevent: done\ndata: {}\n\n');
      }, 30);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  const port = await listen(server);
  const harness = await launchNativeMessagingHarness(port);

  try {
    await seedSettings(harness, {
      token: "native-e2e-token",
      daemonPort: String(port),
      summaryRuntime: "daemon",
      slideRuntime: "browser",
      autoSummarize: false,
      slidesEnabled: false,
    });

    const optionsPage = await harness.context.newPage();
    trackErrors(optionsPage, harness.pageErrors, harness.consoleErrors);
    await optionsPage.goto(getExtensionUrl(harness, "options.html"));
    await expect(optionsPage.locator("#daemonStatus")).toContainText("Daemon vnative-e2e");
    await optionsPage.click("#tab-advanced");
    await expect(optionsPage.locator("#modelPreset")).toContainText(
      "native/e2e — Through native host",
    );

    const panel = await harness.context.newPage();
    trackErrors(panel, harness.pageErrors, harness.consoleErrors);
    await panel.goto(getExtensionUrl(harness, "sidepanel.html"));
    await waitForPanelPort(panel);
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://example.com/native", title: "Native E2E" },
        settings: {
          summaryRuntime: "daemon",
          slideRuntime: "browser",
          autoSummarize: false,
          tokenPresent: true,
          slidesEnabled: false,
        },
      }),
    });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "native-run",
        url: "https://example.com/native",
        title: "Native E2E",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(panel.locator("#render")).toContainText("Native summary");

    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: "/health" }),
        expect.objectContaining({
          url: "/v1/ping",
          authorization: "Bearer native-e2e-token",
        }),
        expect.objectContaining({
          url: "/v1/models",
          authorization: "Bearer native-e2e-token",
        }),
        expect.objectContaining({
          url: "/v1/summarize/native-run/events",
          authorization: "Bearer native-e2e-token",
        }),
      ]),
    );
    expect(harness.pageErrors).toEqual([]);
    expect(harness.consoleErrors).toEqual([]);
  } finally {
    for (const manifestPath of harness.nativeManifestPaths) {
      fs.rmSync(manifestPath, { force: true });
    }
    await closeExtension(harness.context, harness.userDataDir);
    await closeServer(server);
  }
});
