import {
  deleteArtifact,
  getArtifactRecord,
  listArtifacts,
  parseArtifact,
  upsertArtifact,
} from "../../automation/artifacts-store";
import {
  getArtifactsGuardError,
  getNativeInputGuardError,
  updateArmedTabs,
} from "../../automation/native-input-guard";

export type NativeInputRequest = {
  type: "automation:native-input";
  payload: {
    action: "click" | "type" | "press" | "keydown" | "keyup";
    x?: number;
    y?: number;
    text?: string;
    key?: string;
  };
};

export type NativeInputResponse = { ok: true } | { ok: false; error: string };

export type ArtifactsRequest = {
  type: "automation:artifacts";
  requestId: string;
  action?: string;
  payload?: unknown;
};

type RuntimeMessage =
  | NativeInputRequest
  | ArtifactsRequest
  | { type: "automation:native-input-arm"; tabId?: number; enabled?: boolean }
  | { type: "automation:artifacts-arm"; tabId?: number; enabled?: boolean };

function safeSendResponse(sendResponse: (response?: unknown) => void, value: unknown) {
  try {
    sendResponse(value);
  } catch {
    // ignore
  }
}

function resolveKeyCode(key: string): { code: string; keyCode: number; text?: string } {
  const named: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  };
  if (named[key]) {
    return { code: key, keyCode: named[key] };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { code: upper, keyCode: upper.charCodeAt(0), text: key };
  }
  return { code: key, keyCode: 0 };
}

async function dispatchNativeInput(
  tabId: number,
  payload: NativeInputRequest["payload"],
): Promise<NativeInputResponse> {
  const hasPermission = await chrome.permissions.contains({ permissions: ["debugger"] });
  if (!hasPermission) {
    return { ok: false, error: "Debugger permission not granted." };
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("already attached")) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const send = (method: string, params: Record<string, unknown>) =>
    chrome.debugger.sendCommand({ tabId }, method, params);

  try {
    switch (payload.action) {
      case "click": {
        const x = payload.x ?? 0;
        const y = payload.y ?? 0;
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          x,
          y,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          x,
          y,
        });
        return { ok: true };
      }
      case "type": {
        const text = payload.text ?? "";
        if (!text) return { ok: false, error: "Missing text" };
        await send("Input.insertText", { text });
        return { ok: true };
      }
      case "press":
      case "keydown":
      case "keyup": {
        const key = payload.key ?? "";
        if (!key) return { ok: false, error: "Missing key" };
        const { code, keyCode, text } = resolveKeyCode(key);
        const sendKey = async (type: string) =>
          send("Input.dispatchKeyEvent", {
            type,
            key,
            code,
            text,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          });
        if (payload.action === "press") {
          await sendKey("keyDown");
          await sendKey("keyUp");
          return { ok: true };
        }
        await sendKey(payload.action === "keydown" ? "keyDown" : "keyUp");
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // ignore
    }
  }
}

export function createRuntimeActionsHandler({
  nativeInputArmedTabs,
  artifactsArmedTabs,
}: {
  nativeInputArmedTabs: Set<number>;
  artifactsArmedTabs: Set<number>;
}) {
  return (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }

    const type = (raw as RuntimeMessage).type;
    if (type === "automation:native-input-arm" || type === "automation:artifacts-arm") {
      const msg = raw as { tabId?: number; enabled?: boolean };
      updateArmedTabs({
        armedTabs:
          type === "automation:native-input-arm" ? nativeInputArmedTabs : artifactsArmedTabs,
        senderHasTab: Boolean(sender.tab),
        tabId: msg.tabId,
        enabled: msg.enabled,
      });
      return;
    }

    if (type === "automation:native-input") {
      const msg = raw as NativeInputRequest;
      void (async () => {
        const tabId = sender.tab?.id;
        const guardError = getNativeInputGuardError({
          armedTabs: nativeInputArmedTabs,
          senderTabId: tabId,
        });
        if (guardError) {
          safeSendResponse(sendResponse, {
            ok: false,
            error: guardError,
          } satisfies NativeInputResponse);
          return;
        }
        const result = await dispatchNativeInput(tabId, msg.payload);
        safeSendResponse(sendResponse, result);
      })();
      return true;
    }

    if (type !== "automation:artifacts") return;

    const msg = raw as ArtifactsRequest;
    void (async () => {
      const tabId = sender.tab?.id;
      const guardError = getArtifactsGuardError({
        armedTabs: artifactsArmedTabs,
        senderTabId: tabId,
      });
      if (guardError) {
        safeSendResponse(sendResponse, { ok: false, error: guardError });
        return;
      }

      const payload = (msg.payload ?? {}) as {
        fileName?: string;
        content?: unknown;
        mimeType?: string;
        asBase64?: boolean;
      };

      try {
        if (msg.action === "listArtifacts") {
          const records = await listArtifacts(tabId);
          safeSendResponse(sendResponse, {
            ok: true,
            result: records.map(({ fileName, mimeType, size, updatedAt }) => ({
              fileName,
              mimeType,
              size,
              updatedAt,
            })),
          });
          return;
        }

        if (msg.action === "getArtifact") {
          if (!payload.fileName) throw new Error("Missing fileName");
          const record = await getArtifactRecord(tabId, payload.fileName);
          if (!record) throw new Error(`Artifact not found: ${payload.fileName}`);
          const isText =
            record.mimeType.startsWith("text/") ||
            record.mimeType === "application/json" ||
            record.fileName.endsWith(".json");
          const value = payload.asBase64 ? record : isText ? parseArtifact(record) : record;
          safeSendResponse(sendResponse, { ok: true, result: value });
          return;
        }

        if (msg.action === "createOrUpdateArtifact") {
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
          safeSendResponse(sendResponse, {
            ok: true,
            result: {
              fileName: record.fileName,
              mimeType: record.mimeType,
              size: record.size,
              updatedAt: record.updatedAt,
            },
          });
          return;
        }

        if (msg.action === "deleteArtifact") {
          if (!payload.fileName) throw new Error("Missing fileName");
          const deleted = await deleteArtifact(tabId, payload.fileName);
          safeSendResponse(sendResponse, { ok: true, result: { ok: deleted } });
          return;
        }

        throw new Error(`Unknown artifact action: ${msg.action ?? "unknown"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeSendResponse(sendResponse, { ok: false, error: message });
      }
    })();
    return true;
  };
}
