import {
  deleteArtifact,
  getArtifactRecord,
  listArtifacts,
  parseArtifact,
  upsertArtifact,
} from "./artifacts-store";
import { withNativeInputArmedTab } from "./native-input-guard";
import { executeNavigateTool } from "./navigate";
import { listSkills } from "./skills-store";
import { buildUserScriptsGuidance, getUserScriptsStatus } from "./userscripts";

export type ReplArgs = {
  title: string;
  code: string;
};

export type SandboxFile = {
  fileName: string;
  mimeType: string;
  contentBase64: string;
};

let activeAbortController: AbortController | null = null;
let replAbortListenerAttached = false;

function ensureReplAbortListener() {
  if (replAbortListenerAttached) return;
  replAbortListenerAttached = true;
  chrome.runtime.onMessage.addListener((raw) => {
    if (!raw || typeof raw !== "object") return;
    const type = (raw as { type?: string }).type;
    if (type === "automation:abort-repl" || type === "automation:abort-agent") {
      activeAbortController?.abort();
    }
  });
}

type BrowserJsResult = {
  ok: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
};

type ReplResult = {
  output: string;
  files?: SandboxFile[];
};

const NAVIGATION_PATTERNS = [
  /\bwindow\.location\s*=\s*['"`]/i,
  /\blocation\.href\s*=\s*['"`]/i,
  /\bwindow\.location\.href\s*=\s*['"`]/i,
  /\blocation\.assign\s*\(/i,
  /\blocation\.replace\s*\(/i,
  /\bwindow\.location\.assign\s*\(/i,
  /\bwindow\.location\.replace\s*\(/i,
  /\bhistory\.back\s*\(/i,
  /\bhistory\.forward\s*\(/i,
  /\bhistory\.go\s*\(/i,
];

function validateReplCode(code: string): void {
  for (const pattern of NAVIGATION_PATTERNS) {
    if (pattern.test(code)) {
      throw new Error("Use navigate() instead of window.location/history inside REPL code.");
    }
  }
}

async function ensureAutomationContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/automation.js"],
    });
  } catch {
    // ignore
  }
}

async function sendReplOverlay(
  tabId: number,
  action: "show" | "hide",
  message?: string,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "automation:repl-overlay",
      action,
      message: message ?? null,
    });
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const noReceiver =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection");
    if (!noReceiver) return;
  }

  await ensureAutomationContentScript(tabId);
  await new Promise((resolve) => setTimeout(resolve, 120));
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "automation:repl-overlay",
      action,
      message: message ?? null,
    });
  } catch {
    // ignore
  }
}

async function hasDebuggerPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ["debugger"] });
}

async function runBrowserJs(
  fnSource: string,
  args: unknown[] = [],
  signal?: AbortSignal,
): Promise<BrowserJsResult> {
  if (signal?.aborted) {
    return { ok: false, error: "Execution aborted" };
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-scripts/automation.js"],
    });
  } catch {
    // ignore (optional; used for native input bridge + picker)
  }

  const skills = await listSkills(tab.url ?? undefined);
  const libraries = skills.map((skill) => skill.library).filter(Boolean);
  const nativeInputEnabled = await hasDebuggerPermission();

  const userScripts = chrome.userScripts as
    | {
        execute?: (options: {
          target: { tabId: number; allFrames?: boolean };
          world: "USER_SCRIPT";
          worldId?: string;
          injectImmediately?: boolean;
          js: Array<{ code: string }>;
        }) => Promise<Array<{ result?: unknown }>>;
        configureWorld?: (options: {
          worldId: string;
          messaging?: boolean;
          csp?: string;
        }) => Promise<void>;
      }
    | undefined;
  // userScripts is required for main-world execution; isolated-world fallback is intentionally avoided.
  const status = await getUserScriptsStatus();
  if (!userScripts?.execute || !status.apiAvailable) {
    throw new Error(buildUserScriptsGuidance(status));
  }
  if (!status.permissionGranted) {
    throw new Error(buildUserScriptsGuidance(status));
  }

  const terminate =
    // @ts-expect-error - terminate is not yet in the type definitions
    typeof chrome.userScripts?.terminate === "function"
      ? // @ts-expect-error - terminate is not yet in the type definitions
        chrome.userScripts.terminate.bind(chrome.userScripts)
      : null;

  const executionId = terminate ? crypto.randomUUID() : undefined;
  let abortHandler: (() => void) | null = null;

  if (signal && executionId && terminate) {
    abortHandler = () => {
      try {
        terminate(tab.id, executionId);
      } catch {
        // ignore
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  const argsJson = (() => {
    try {
      return JSON.stringify(args ?? []);
    } catch {
      return "[]";
    }
  })();

  const libs = libraries.filter(Boolean).join("\n");
  const wrapperCode = `
      (async () => {
        const logs = []
        const capture = (...args) => {
          logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
        }
        const originalLog = console.log
        console.log = (...args) => {
          capture(...args)
          originalLog(...args)
        }

        const postNativeInput = (payload) => {
          if (!${nativeInputEnabled ? "true" : "false"}) {
            throw new Error('Native input requires debugger permission')
          }
          return new Promise((resolve, reject) => {
            const requestId = \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`
            const handler = (event) => {
              if (event.source !== window) return
              const msg = event.data || {}
              if (msg?.source !== 'summarize-native-input' || msg.requestId !== requestId) return
              window.removeEventListener('message', handler)
              if (msg.ok) resolve(true)
              else reject(new Error(msg.error || 'Native input failed'))
            }
            window.addEventListener('message', handler)
            window.postMessage({ source: 'summarize-native-input', requestId, payload }, '*')
          })
        }

        const sendArtifactRpc = (action, payload) => {
          return new Promise((resolve, reject) => {
            const requestId = \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`
            const handler = (event) => {
              if (event.source !== window) return
              const msg = event.data || {}
              if (msg?.source !== 'summarize-artifacts' || msg.requestId !== requestId) return
              window.removeEventListener('message', handler)
              if (msg.ok) resolve(msg.result)
              else reject(new Error(msg.error || 'Artifact operation failed'))
            }
            window.addEventListener('message', handler)
            window.postMessage({ source: 'summarize-artifacts', requestId, action, payload }, '*')
          })
        }

        const attachNativeHelpers = () => {
          const resolveElement = (selector) => {
            const el = document.querySelector(selector)
            if (!el) throw new Error(\`Element not found: \${selector}\`)
            return el
          }

          window.nativeClick = async (selector) => {
            const el = resolveElement(selector)
            const rect = el.getBoundingClientRect()
            await postNativeInput({ action: 'click', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          }

          window.nativeType = async (selector, text) => {
            const el = resolveElement(selector)
            el.focus()
            await postNativeInput({ action: 'type', text })
          }

          window.nativePress = async (key) => {
            await postNativeInput({ action: 'press', key })
          }

          window.nativeKeyDown = async (key) => {
            await postNativeInput({ action: 'keydown', key })
          }

          window.nativeKeyUp = async (key) => {
            await postNativeInput({ action: 'keyup', key })
          }
        }

        const attachArtifactHelpers = () => {
          window.listArtifacts = async () => sendArtifactRpc('listArtifacts', {})
          window.getArtifact = async (fileName, options) =>
            sendArtifactRpc('getArtifact', { fileName, ...(options || {}) })
          window.createOrUpdateArtifact = async (fileName, content, mimeType) =>
            sendArtifactRpc('createOrUpdateArtifact', { fileName, content, mimeType })
          window.deleteArtifact = async (fileName) =>
            sendArtifactRpc('deleteArtifact', { fileName })
        }

        try {
          attachNativeHelpers()
          attachArtifactHelpers()
          ${libs}
          const fn = (${fnSource})
          const args = ${argsJson}
          const value = await fn(...args)
          return { ok: true, value, logs }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, error: message, logs }
        } finally {
          console.log = originalLog
        }
      })()
    `;

  try {
    await userScripts.configureWorld?.({
      worldId: "summarize-browserjs",
      messaging: false,
      csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
    });
  } catch {
    // ignore
  }

  try {
    return await withNativeInputArmedTab({
      enabled: nativeInputEnabled,
      tabId: tab.id,
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      run: async () => {
        const results = await userScripts.execute({
          target: { tabId: tab.id },
          world: "USER_SCRIPT",
          worldId: "summarize-browserjs",
          injectImmediately: true,
          js: [{ code: wrapperCode }],
          ...(executionId ? { executionId } : {}),
        });

        if (signal?.aborted) {
          return { ok: false, error: "Execution aborted" };
        }

        const result = results?.[0]?.result as BrowserJsResult | undefined;
        return result ?? { ok: false, error: "No result from browserjs()" };
      },
    });
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

function buildSandboxHtml(): string {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
      </head>
      <body>
        <script>
          const formatValue = (value) => {
            if (value == null) return 'null'
            if (typeof value === 'string') return value
            try { return JSON.stringify(value) } catch { return String(value) }
          }

          const toBase64 = (input) => {
            if (typeof input === 'string') {
              return btoa(unescape(encodeURIComponent(input)))
            }
            if (input instanceof ArrayBuffer) {
              const bytes = new Uint8Array(input)
              let binary = ''
              bytes.forEach((b) => { binary += String.fromCharCode(b) })
              return btoa(binary)
            }
            if (ArrayBuffer.isView(input)) {
              const bytes = new Uint8Array(input.buffer)
              let binary = ''
              bytes.forEach((b) => { binary += String.fromCharCode(b) })
              return btoa(binary)
            }
            return btoa(unescape(encodeURIComponent(String(input))))
          }

          const sendRpc = (action, payload) => {
            return new Promise((resolve, reject) => {
              const requestId = \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`
              const handler = (event) => {
                const data = event.data || {}
                if (data.source !== 'summarize-repl' || data.type !== 'rpc-result') return
                if (data.requestId !== requestId) return
                window.removeEventListener('message', handler)
                if (data.ok) resolve(data.result)
                else reject(new Error(data.error || 'RPC failed'))
              }
              window.addEventListener('message', handler)
              window.parent.postMessage(
                { source: 'summarize-repl', type: 'rpc', requestId, action, payload },
                '*'
              )
            })
          }

          window.addEventListener('message', async (event) => {
            const data = event.data || {}
            if (data.source !== 'summarize-repl' || data.type !== 'execute') return

            const { requestId, code } = data
            const logs = []
            const files = []

            const original = { ...console }
            const capture = (...args) => {
              logs.push(args.map((arg) => formatValue(arg)).join(' '))
            }
            console.log = (...args) => { capture(...args); original.log(...args) }
            console.info = (...args) => { capture(...args); original.info(...args) }
            console.warn = (...args) => { capture(...args); original.warn(...args) }
            console.error = (...args) => { capture(...args); original.error(...args) }

            const browserjs = async (fn, ...args) => {
              if (typeof fn !== 'function') throw new Error('browserjs() expects a function')
              const result = await sendRpc('browserjs', { fnSource: fn.toString(), args })
              if (result && typeof result === 'object' && '__browserLogs' in result) {
                const payload = result
                if (Array.isArray(payload.__browserLogs)) {
                  logs.push(...payload.__browserLogs)
                }
                return payload.value
              }
              return result
            }

            const navigate = async (args) => sendRpc('navigate', args)

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

            const listArtifacts = async () => sendRpc('listArtifacts', {})
            const getArtifact = async (fileName, options) =>
              sendRpc('getArtifact', { fileName, ...(options || {}) })
            const createOrUpdateArtifact = async (fileName, content, mimeType) =>
              sendRpc('createOrUpdateArtifact', { fileName, content, mimeType })
            const deleteArtifact = async (fileName) =>
              sendRpc('deleteArtifact', { fileName })

            const returnFile = (fileNameOrObj, maybeContent, maybeMimeType) => {
              let fileName = ''
              let content = ''
              let mimeType = 'text/plain'
              if (typeof fileNameOrObj === 'object' && fileNameOrObj) {
                fileName = fileNameOrObj.fileName || fileNameOrObj.name || ''
                content = fileNameOrObj.content ?? ''
                mimeType = fileNameOrObj.mimeType || fileNameOrObj.type || mimeType
              } else {
                fileName = String(fileNameOrObj || '')
                content = maybeContent ?? ''
                mimeType = maybeMimeType || mimeType
              }
              if (!fileName) {
                throw new Error('returnFile() requires a fileName')
              }
              const contentBase64 = toBase64(content)
              files.push({ fileName, mimeType, contentBase64 })
            }

            try {
              const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
              const fn = new AsyncFunction(
                'browserjs',
                'navigate',
                'sleep',
                'returnFile',
                'createOrUpdateArtifact',
                'getArtifact',
                'listArtifacts',
                'deleteArtifact',
                'console',
                code
              )
              const result = await fn(
                browserjs,
                navigate,
                sleep,
                returnFile,
                createOrUpdateArtifact,
                getArtifact,
                listArtifacts,
                deleteArtifact,
                console
              )
              if (result !== undefined) {
                logs.push(\`=> \${formatValue(result)}\`)
              }
              window.parent.postMessage(
                { source: 'summarize-repl', type: 'result', requestId, ok: true, logs, files },
                '*'
              )
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              window.parent.postMessage(
                { source: 'summarize-repl', type: 'result', requestId, ok: false, error: message, logs, files },
                '*'
              )
            } finally {
              console.log = original.log
              console.info = original.info
              console.warn = original.warn
              console.error = original.error
            }
          })
        </script>
      </body>
    </html>
  `;
}

async function runSandboxedRepl(
  code: string,
  handlers: {
    onBrowserJs: (payload: { fnSource: string; args: unknown[] }) => Promise<unknown>;
    onNavigate: (payload: { url: string; newTab?: boolean }) => Promise<unknown>;
    onArtifacts: (payload: {
      action: "list" | "get" | "upsert" | "delete";
      fileName?: string;
      content?: unknown;
      mimeType?: string;
      asBase64?: boolean;
    }) => Promise<unknown>;
  },
  signal?: AbortSignal,
): Promise<{ logs: string[]; files: SandboxFile[]; error?: string }> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.style.display = "none";
  iframe.srcdoc = buildSandboxHtml();

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve) => {
    const abortHandler = () => {
      cleanup();
      resolve({ logs: [], files: [], error: "Execution aborted" });
    };

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      window.removeEventListener("message", onMessage);
      iframe.remove();
    };

    const sendExecute = () => {
      iframe.contentWindow?.postMessage(
        { source: "summarize-repl", type: "execute", requestId, code },
        "*",
      );
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as {
        source?: string;
        type?: string;
        requestId?: string;
        action?: string;
        payload?: unknown;
        ok?: boolean;
        result?: unknown;
        error?: string;
        logs?: string[];
        files?: SandboxFile[];
      };
      if (data?.source !== "summarize-repl") return;
      if (data.type === "rpc" && data.requestId) {
        const handle = async () => {
          try {
            if (data.action === "browserjs") {
              const result = await handlers.onBrowserJs(
                data.payload as { fnSource: string; args: unknown[] },
              );
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else if (data.action === "navigate") {
              const result = await handlers.onNavigate(
                data.payload as { url: string; newTab?: boolean },
              );
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else if (data.action === "listArtifacts") {
              const result = await handlers.onArtifacts({ action: "list" });
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else if (data.action === "getArtifact") {
              const result = await handlers.onArtifacts({
                action: "get",
                ...(data.payload as { fileName?: string; asBase64?: boolean }),
              });
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else if (data.action === "createOrUpdateArtifact") {
              const result = await handlers.onArtifacts({
                action: "upsert",
                ...(data.payload as { fileName?: string; content?: unknown; mimeType?: string }),
              });
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else if (data.action === "deleteArtifact") {
              const result = await handlers.onArtifacts({
                action: "delete",
                ...(data.payload as { fileName?: string }),
              });
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: true,
                  result,
                },
                "*",
              );
            } else {
              iframe.contentWindow?.postMessage(
                {
                  source: "summarize-repl",
                  type: "rpc-result",
                  requestId: data.requestId,
                  ok: false,
                  error: `Unknown action: ${data.action}`,
                },
                "*",
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            iframe.contentWindow?.postMessage(
              {
                source: "summarize-repl",
                type: "rpc-result",
                requestId: data.requestId,
                ok: false,
                error: message,
              },
              "*",
            );
          }
        };
        void handle();
        return;
      }

      if (data.type === "result" && data.requestId === requestId) {
        cleanup();
        resolve({
          logs: data.logs ?? [],
          files: data.files ?? [],
          error: data.ok ? undefined : data.error || "Execution failed",
        });
      }
    };

    window.addEventListener("message", onMessage);
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    iframe.addEventListener("load", sendExecute, { once: true });
    document.body.appendChild(iframe);
  });
}

export async function executeReplTool(args: ReplArgs): Promise<ReplResult> {
  if (!args.code?.trim()) throw new Error("Missing code");
  validateReplCode(args.code);
  ensureReplAbortListener();

  const usesBrowserJs = args.code.includes("browserjs(");
  let overlayTabId: number | null = null;
  const abortController = new AbortController();
  activeAbortController = abortController;
  if (usesBrowserJs) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      overlayTabId = tab.id;
      await sendReplOverlay(overlayTabId, "show", args.title || "Running automation");
    }
  }

  try {
    const sandboxResult = await runSandboxedRepl(
      args.code,
      {
        onBrowserJs: async ({ fnSource, args: fnArgs }) => {
          const res = await runBrowserJs(fnSource, fnArgs, abortController.signal);
          if (!res.ok) throw new Error(res.error || "browserjs failed");
          if (res.logs?.length) {
            return { value: res.value, __browserLogs: res.logs };
          }
          return res.value;
        },
        onNavigate: async (input) => executeNavigateTool(input),
        onArtifacts: async (payload) => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) throw new Error("No active tab");
          const tabId = tab.id;

          if (payload.action === "list") {
            const records = await listArtifacts(tabId);
            return records.map(({ fileName, mimeType, size, updatedAt }) => ({
              fileName,
              mimeType,
              size,
              updatedAt,
            }));
          }

          if (payload.action === "get") {
            if (!payload.fileName) throw new Error("Missing fileName");
            const record = await getArtifactRecord(tabId, payload.fileName);
            if (!record) throw new Error(`Artifact not found: ${payload.fileName}`);
            if (payload.asBase64) {
              return record;
            }
            const isText =
              record.mimeType.startsWith("text/") ||
              record.mimeType === "application/json" ||
              record.fileName.endsWith(".json");
            return isText ? parseArtifact(record) : record;
          }

          if (payload.action === "upsert") {
            if (!payload.fileName) throw new Error("Missing fileName");
            const record = await upsertArtifact(tabId, {
              fileName: payload.fileName,
              content: payload.content,
              mimeType: payload.mimeType,
              contentBase64:
                typeof payload.content === "object" &&
                payload.content &&
                "contentBase64" in payload.content
                  ? (payload.content as { contentBase64?: string }).contentBase64
                  : undefined,
            });
            return {
              fileName: record.fileName,
              mimeType: record.mimeType,
              size: record.size,
              updatedAt: record.updatedAt,
            };
          }

          if (payload.action === "delete") {
            if (!payload.fileName) throw new Error("Missing fileName");
            return { ok: await deleteArtifact(tabId, payload.fileName) };
          }

          throw new Error(`Unknown artifact action: ${payload.action}`);
        },
      },
      abortController.signal,
    );

    const logs = sandboxResult.logs ?? [];
    if (sandboxResult.files?.length) {
      logs.push(`[Files returned: ${sandboxResult.files.length}]`);
      for (const file of sandboxResult.files) {
        logs.push(`- ${file.fileName} (${file.mimeType})`);
      }
    }
    if (sandboxResult.error) {
      logs.push(`Error: ${sandboxResult.error}`);
    }
    const output = logs.join("\n").trim() || "Code executed successfully (no output)";
    return {
      output,
      files: sandboxResult.files?.length ? sandboxResult.files : undefined,
    };
  } finally {
    abortController.abort();
    activeAbortController = null;
    if (overlayTabId) {
      await sendReplOverlay(overlayTabId, "hide");
    }
  }
}
