import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNativeMessagingLauncher,
  buildNativeMessagingManifest,
  installNativeMessagingHost,
  resolveChromeNativeMessagingManifestPath,
  uninstallNativeMessagingHost,
} from "../src/daemon/native-messaging-install.js";
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  runNativeMessagingHost,
  type NativeHostOutput,
} from "../src/daemon/native-messaging.js";

const temporaryHomes: string[] = [];

async function createHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "summarize-native-"));
  temporaryHomes.push(home);
  await fs.mkdir(path.join(home, ".summarize"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".summarize", "daemon.json"),
    `${JSON.stringify({
      version: 2,
      token: "native-test-token",
      tokens: ["native-test-token"],
      port: 19001,
      env: {},
      installedAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
  );
  return home;
}

async function runHostRequest(
  request: Parameters<typeof encodeNativeMessage>[0],
  fetchImpl: typeof fetch,
) {
  const home = await createHome();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messages: NativeHostOutput[] = [];
  stdout.on(
    "data",
    createNativeMessageDecoder((message) => messages.push(message as NativeHostOutput)),
  );
  const running = runNativeMessagingHost({
    env: { HOME: home },
    argv: ["chrome-extension://cejgnmmhbbpdmjnfppjdfkocebngehfg/"],
    stdin,
    stdout,
    fetchImpl,
  });
  stdin.end(encodeNativeMessage(request));
  await running;
  return messages;
}

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map((home) => fs.rm(home, { recursive: true })));
});

describe("native messaging host", () => {
  it("proxies an authenticated request and preserves streamed binary chunks", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:19001/v1/summarize/run-1/events?cursor=2");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer native-test-token");
      expect(Buffer.from(init?.body as Uint8Array).toString("utf8")).toBe('{"ok":true}');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("event: chunk\n"));
            controller.enqueue(new Uint8Array([0, 1, 2, 255]));
            controller.close();
          },
        }),
        {
          status: 206,
          statusText: "Partial Content",
          headers: { "content-type": "text/event-stream" },
        },
      );
    });

    const messages = await runHostRequest(
      {
        type: "request",
        method: "POST",
        path: "/v1/summarize/run-1/events?cursor=2",
        port: 19001,
        headers: {
          authorization: "Bearer native-test-token",
          "content-type": "application/json",
          host: "attacker.invalid",
        },
        body: Buffer.from('{"ok":true}').toString("base64"),
      },
      fetchImpl,
    );

    expect(messages[0]).toMatchObject({
      type: "response",
      status: 206,
      statusText: "Partial Content",
    });
    const output = Buffer.concat(
      messages
        .filter(
          (message): message is Extract<NativeHostOutput, { type: "chunk" }> =>
            message.type === "chunk",
        )
        .map((message) => Buffer.from(message.data, "base64")),
    );
    expect(output).toEqual(
      Buffer.concat([Buffer.from("event: chunk\n"), Buffer.from([0, 1, 2, 255])]),
    );
    expect(messages.at(-1)).toEqual({ type: "end" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects paths outside the daemon API without making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const messages = await runHostRequest(
      {
        type: "request",
        method: "GET",
        path: "http://example.com/private",
        port: 19001,
        headers: {},
      },
      fetchImpl,
    );
    expect(messages).toEqual([
      { type: "error", message: "Native requests must use a relative daemon path" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects callers other than the configured extension ID", async () => {
    const home = await createHome();
    await expect(
      runNativeMessagingHost({
        env: { HOME: home },
        argv: ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"],
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      }),
    ).rejects.toThrow("caller is not allowed");
  });
});

describe("native messaging installation", () => {
  it("writes an executable launcher and an exact-ID Chrome host manifest", async () => {
    const home = await createHome();
    const env = { HOME: home };
    const result = await installNativeMessagingHost({
      env,
      platform: "darwin",
      program: {
        programArguments: [
          "/opt/node path/bin/node",
          "/opt/summarize/cli.js",
          "daemon",
          "native-host",
        ],
        workingDirectory: "/opt/summarize source",
      },
    });
    expect(result.installed).toBe(true);
    const manifestPath = resolveChromeNativeMessagingManifestPath(env, "darwin");
    expect(result.manifestPath).toBe(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath!, "utf8"));
    expect(manifest).toEqual(
      buildNativeMessagingManifest({ launcherPath: path.join(home, ".summarize", "native-host") }),
    );
    expect(manifest.allowed_origins).toEqual([
      "chrome-extension://cejgnmmhbbpdmjnfppjdfkocebngehfg/",
    ]);
    const launcher = await fs.readFile(result.launcherPath!, "utf8");
    expect(launcher).toBe(
      buildNativeMessagingLauncher({
        programArguments: [
          "/opt/node path/bin/node",
          "/opt/summarize/cli.js",
          "daemon",
          "native-host",
        ],
        workingDirectory: "/opt/summarize source",
      }),
    );
    expect((await fs.stat(result.launcherPath!)).mode & 0o777).toBe(0o700);

    await uninstallNativeMessagingHost({ env, platform: "darwin" });
    await expect(fs.access(manifestPath!)).rejects.toThrow();
    await expect(fs.access(result.launcherPath!)).rejects.toThrow();
  });

  it("reports the Windows executable packaging requirement without writing a weak launcher", async () => {
    const home = await createHome();
    const result = await installNativeMessagingHost({
      env: { HOME: home },
      platform: "win32",
      program: { programArguments: ["C:\\Program Files\\nodejs\\node.exe", "cli.js"] },
    });
    expect(result).toMatchObject({
      installed: false,
      launcherPath: null,
      reason: "Windows requires a packaged native-host executable",
    });
  });
});
