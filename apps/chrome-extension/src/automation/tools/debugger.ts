export async function executeDebuggerTool(args: { action?: string; code?: string }) {
  if (args.action !== "eval") throw new Error("Unsupported debugger action");
  if (!args.code) throw new Error("Missing code");

  const hasPermission = await chrome.permissions.contains({ permissions: ["debugger"] });
  if (!hasPermission) {
    throw new Error(
      "Debugger permission not granted. Enable it in Options → Automation permissions.",
    );
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const tabId = tab.id;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already attached")) throw error;
  }

  try {
    const result = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: args.code,
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    const value = result?.result?.value ?? result?.result ?? null;
    const text =
      value == null ? "null" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { text, details: result };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Best-effort cleanup after the debugger command.
    }
  }
}
