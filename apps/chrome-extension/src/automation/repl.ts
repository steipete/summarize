import { executeNavigateTool } from "./navigate";
import { handleReplArtifactAction } from "./repl-artifacts";
import { ensureAutomationContentScript, runBrowserJs } from "./repl-browser-js";
import { validateReplCode } from "./repl-policy";
import { runSandboxedRepl } from "./repl-sandbox";
import type { SandboxFile } from "./repl-sandbox-contracts";

export type { SandboxFile } from "./repl-sandbox-contracts";

export type ReplArgs = {
  title: string;
  code: string;
};

let activeAbortController: AbortController | null = null;
let replAbortListenerAttached = false;

function ensureReplAbortListener(): void {
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

type ReplResult = {
  output: string;
  files?: SandboxFile[];
};

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
    // i18n-ignore: Chrome extension messaging diagnostics.
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
    // Overlay is best-effort.
  }
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
        onArtifacts: handleReplArtifactAction,
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
