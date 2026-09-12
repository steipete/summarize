import { withArtifactsArmedTab, withNativeInputArmedTab } from "./native-input-guard";
import { buildBrowserJsWrapper } from "./repl-browser-script";
import { listSkills } from "./skills-store";
import { buildUserScriptsGuidance, getUserScriptsStatus } from "./userscripts";

export type BrowserJsResult = {
  ok: boolean;
  value?: unknown;
  logs?: string[];
  error?: string;
};

export async function ensureAutomationContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-scripts/automation.js"],
    });
  } catch {
    // Optional bridge/picker content script may already be unavailable.
  }
}

async function hasDebuggerPermission(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ["debugger"] });
}

export async function runBrowserJs(
  fnSource: string,
  args: unknown[] = [],
  signal?: AbortSignal,
): Promise<BrowserJsResult> {
  if (signal?.aborted) return { ok: false, error: "Execution aborted" };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const tabId = tab.id;

  await ensureAutomationContentScript(tab.id);
  const skills = await listSkills(tab.url ?? undefined);
  const libraries = skills.map((skill) => skill.library).filter(Boolean);
  const nativeInputEnabled = await hasDebuggerPermission();
  const userScripts = chrome.userScripts;
  const status = await getUserScriptsStatus();
  if (!userScripts?.execute || !status.apiAvailable || !status.permissionGranted) {
    throw new Error(buildUserScriptsGuidance(status));
  }

  const nativeInputCapability = nativeInputEnabled ? crypto.randomUUID() : "";
  const wrapperCode = buildBrowserJsWrapper({
    fnSource,
    args,
    libraries,
    nativeInputEnabled,
    nativeInputCapability,
  });

  try {
    await userScripts.configureWorld?.({
      worldId: "summarize-browserjs",
      messaging: true,
      csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
    });
  } catch {
    // World configuration may already exist.
  }

  return await withArtifactsArmedTab({
    enabled: true,
    tabId,
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    run: async () =>
      withNativeInputArmedTab({
        enabled: nativeInputEnabled,
        tabId,
        sendMessage: (message) => chrome.runtime.sendMessage(message),
        capability: nativeInputCapability,
        run: async () => {
          const results = await userScripts.execute!({
            target: { tabId },
            world: "USER_SCRIPT",
            worldId: "summarize-browserjs",
            injectImmediately: true,
            js: [{ code: wrapperCode }],
          });
          if (signal?.aborted) return { ok: false, error: "Execution aborted" };
          const result = results?.[0]?.result as BrowserJsResult | undefined;
          return result ?? { ok: false, error: "No result from browserjs()" };
        },
      }),
  });
}
