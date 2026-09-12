export type ElementInfo = {
  selector: string;
  xpath: string;
  html: string;
  tagName: string;
  attributes: Record<string, string>;
  text: string;
  boundingBox: { x: number; y: number; width: number; height: number };
};

export type AskUserWhichElementArgs = {
  message?: string;
};

export async function executeAskUserWhichElementTool(
  args: AskUserWhichElementArgs,
): Promise<ElementInfo> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const tabId = tab.id;

  const ensureInjected = async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-scripts/automation.js"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        message.toLowerCase().includes("cannot access") || message.toLowerCase().includes("denied")
          ? `Chrome blocked content access (${message}). Check extension “Site access” → “On all sites”, then reload the tab.`
          : `Failed to inject automation content script (${message}). Check extension “Site access”, then reload the tab.`,
      );
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = (await chrome.tabs.sendMessage(tab.id, {
        type: "automation:pick-element",
        message: args.message ?? null,
      })) as { ok: boolean; result?: ElementInfo; error?: string };

      if (!response.ok || !response.result) {
        throw new Error(response.error || "Element picker failed");
      }

      return response.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noReceiver =
        message.includes("Receiving end does not exist") ||
        message.includes("Could not establish connection");
      if (noReceiver) {
        await ensureInjected();
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      throw err;
    }
  }

  throw new Error("Element picker not available");
}
