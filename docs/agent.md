---
summary: "Automation agent for the Chrome side panel (daemon-backed)."
read_when:
  - "When working on automation tools, /v1/agent, or the side panel agent loop."
---

# Automation Agent (Side Panel + Daemon)

Summarize can run as a **website automation agent** inside the Chrome side panel. This is **optional** and **gated by a checkbox** in Options.

Scope:

- **Off (default):** chat is Q&A only (no tools).
- **On:** chat runs a tool-capable agent for web automation.

Explicit exclusions (per product direction): **no update checker**, **no tutorial/welcome flow**, **no proxy config**, **no API key dialog**. All model calls go through the **local daemon**.

## Architecture (High Level)

1. **Side panel** maintains the agent loop + chat UI.
2. **Background** handles tab data, extraction, and tool execution.
3. **Content scripts** handle element picking and native-input bridge.
4. **Daemon** provides `/v1/agent` (SSE stream of chunks + final assistant message).

### Data Flow (Agent Loop)

- User sends a message in the side panel.
- Panel compacts history and sends `panel:agent` to background with:
  - `messages` (pi-ai Message[])
  - `tools` (names)
  - `summary` (optional current summary markdown)
- Background builds `pageContent` using the latest extract (summary + transcript/text + metadata).
- Background calls daemon `POST /v1/agent` (SSE).
- Daemon streams `chunk` events, then an `assistant` event (may include tool calls).
- Panel executes tool calls locally, appends `toolResult` messages, and repeats `/v1/agent` until no tool calls remain.

The daemon **never** executes tools. It only returns the next assistant message.

## Settings + Permissions

### Settings

`automationEnabled` (boolean) lives in `apps/chrome-extension/src/lib/settings.ts`.

- Options UI provides the toggle.
- When disabled, the tool list is empty and the daemon uses the **chat-only** prompt.

### Optional Permissions

Defined in `apps/chrome-extension/wxt.config.ts` and requested via Options:

- `debugger` – required for **native input** and the **debugger** tool.
- `userScripts` – reserved for main-world script execution (not required for current REPL path).

#### Chrome: enable User Scripts (if needed)

1. `chrome://extensions`
2. Open extension details
3. Enable **Allow User Scripts**
4. Reload the tab

## Daemon Endpoint

### `POST /v1/agent` (SSE)

**Headers**

- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Body**

```
{
  "url": "https://...",
  "title": "Page title",
  "pageContent": "<summary + transcript + metadata>",
  "cacheContent": "<transcript/text used for cache key>",
  "messages": [/* pi-ai Message[] */],
  "model": "auto" | "openai/..." | "anthropic/..." | ...,
  "length": "short" | "xl" | "20k" | ...,
  "language": "auto" | "en" | "de" | ...,
  "tools": ["navigate", "repl", "ask_user_which_element", "skill", "debugger"],
  "automationEnabled": true
}
```

**Response (SSE, default)**

```
event: chunk
data: { "text": "..." }

event: assistant
data: { /* AssistantMessage */ }

event: done
data: {}

event: error
data: { "message": "..." }
```

**Response (JSON)**
Use `Accept: application/json` or `?format=json`.

```
{ "ok": true, "assistant": { /* AssistantMessage */ } }
```

### `POST /v1/agent/history`

Returns cached chat history for the same cache key as `/v1/agent`.

**Body**

```
{
  "url": "https://...",
  "pageContent": "<summary + transcript + metadata>",
  "cacheContent": "<transcript/text used for cache key>",
  "model": "auto" | "openai/..." | "anthropic/..." | ...,
  "length": "short" | "xl" | "20k" | ...,
  "language": "auto" | "en" | "de" | ...,
  "automationEnabled": true
}
```

**Response**

```
{ "ok": true, "messages": [/* Message[] */] }
```

### Model Resolution (Daemon)

- **Fixed model** (explicit `model`): parsed as `<provider>/<model>`. Provider base URL overrides come from config/env (OpenAI, Anthropic, Google, xAI, ZAI). OpenRouter uses OpenAI-compatible completions.
- **Auto model**: uses existing auto-selection logic (`buildAutoModelAttempts`), preferring API-key transports and then CLI fallback when available.
- **Synthetic models**: created for OpenAI-compatible base URLs (local/openrouter).
- `maxOutputTokens` defaults to 2048 or `maxOutputTokens` override.
- CLI models are supported as auto fallback and via explicit `cli/<provider>` or `cli/<provider>/<model>` overrides.
- If the daemon still says no model is available after key/install changes, restart or reinstall it so the saved environment snapshot refreshes.

## Page Content Payload

`pageContent` is built from the latest extract and includes:

- **Summary** (optional): current summary markdown (truncated to settings cap).
- **Transcript/text**: timed transcript when available, otherwise extracted text.
- **Metadata**: URL/title, source (`page` vs `url`), extraction strategy, markdown provider, Firecrawl usage, transcript provider + cache status, media duration, word counts, truncation flags.

See `buildChatPageContent()` usage in `apps/chrome-extension/src/entrypoints/background.ts`.

## Tools

### 1) `navigate`

Navigate the active tab.

Params:

```
{ "url": "https://...", "newTab": false }
```

Result:

```
{ "finalUrl": "https://...", "title": "...", "tabId": 123 }
```

Notes:

- Uses `chrome.tabs.update` or `chrome.tabs.create`.
- Waits for tab status `complete` (15s timeout).

### 2) `repl`

Execute JavaScript in a sandbox, with `browserjs()` to run in the page context.

Params:

```
{ "title": "...", "code": "..." }
```

Result:

```
{ "output": "console/return output", "files": [{ "fileName": "...", "mimeType": "...", "contentBase64": "..." }] }
```

REPL environment:

- Runs in a **sandboxed iframe** (no DOM access to the panel).
- `browserjs(fn, ...args)` runs the function **in the page context**.
  - Uses `chrome.userScripts.execute` (main world) when available.
  - Falls back to `chrome.scripting.executeScript` (isolated world).
- `navigate({ url })` available inside the REPL (always use for navigation).
- `sleep(ms)` helper.
- Console output is captured and returned; return values are appended as `=> value`.
- `returnFile(name, content, mimeType)` or `returnFile({ fileName, content, mimeType })` attaches files to the tool result.

Safety:

- Navigation inside REPL code (`window.location`, `history`, etc.) is rejected. Use `navigate()` instead.

Page-context helpers (via `browserjs()`):

- Skills libraries are auto-injected when domain patterns match the active URL.
- If `debugger` permission is granted, native helpers are exposed:
  - `nativeClick(selector)`
  - `nativeType(selector, text)`
  - `nativePress(key)`
  - `nativeKeyDown(key)` / `nativeKeyUp(key)`

### 3) `ask_user_which_element`

Shows a click-to-select overlay and returns element metadata.

Params:

```
{ "message": "Optional guidance" }
```

Result (example):

```
{
  "selector": "#submit",
  "xpath": "//button[1]",
  "text": "Send",
  "tagName": "button",
  "attributes": { "type": "submit" },
  "html": "<button ...>",
  "boundingBox": { "x": 20, "y": 120, "width": 180, "height": 40 }
}
```

Overlay UX:

- Hover highlights element under cursor.
- Click selects.
- ↑ / ↓ moves up or down the DOM tree.
- Esc cancels.

### 4) `skill`

CRUD for domain-specific libraries (stored in `chrome.storage.local`).

Storage keys:

- `automation.skills` (map of name → skill)
- `automation.skillsSeeded` (one-time default seed)

Actions:

- `list` (optionally filtered by URL)
- `get` (optionally includes library code)
- `create` / `rewrite`
- `update` (string replacement)
- `delete`

Default skills seed from `apps/chrome-extension/src/automation/default-skills.json`.

Matching:

- Glob-like domain patterns (supports `*` and `**`).
- Match is done against hostname + path (e.g. `github.com/*/issues`).

Notes:

- `update` is intended for in-place string replacements; use `rewrite` to rename.
- Skills libraries run inside `browserjs()` and must avoid navigation.

### 5) `debugger` (optional)

Runs JavaScript in the **main world** via the Chrome debugger. **Last resort** (shows Chrome debug banner).

Params:

```
{ "action": "eval", "code": "..." }
```

Result:

```
{ "text": "...", "details": { ... } }
```

### 6) `summarize`

Run the Summarize pipeline against a URL (summary or extract-only).

Params:

```
{
  "url": "https://...",
  "extractOnly": false,
  "format": "text",
  "markdownMode": "readability",
  "model": "openai/gpt-5-mini",
  "length": "short",
  "language": "auto",
  "prompt": "Optional override",
  "timeout": "2m",
  "maxOutputTokens": "2k",
  "noCache": false,
  "firecrawl": "auto",
  "preprocess": "auto",
  "youtube": "auto",
  "videoMode": "auto",
  "timestamps": false,
  "maxCharacters": 120000
}
```

Result (summary):

```
{ "output": "..." }
```

Result (extract-only):

```
{ "output": "...", "details": { "content": "...", "title": "...", "wordCount": 123, ... } }
```

Notes:

- URL-only (uses daemon URL pipeline).
- Use `extractOnly: true` + `format: "markdown"` to return extracted Markdown.
- When `format: "markdown"`, `markdownMode` defaults to `readability`.

## Native Input Bridge (Debugger Permission)

Native input events use the Chrome debugger protocol:

- `browserjs()` posts a message to the content script.
- Content script forwards to background (`automation:native-input`).
- Background attaches debugger and dispatches:
  - `Input.dispatchMouseEvent` (click)
  - `Input.insertText` (type)
  - `Input.dispatchKeyEvent` (press/keydown/keyup)

If permission is missing, the call fails and the tool reports the error.

## UX Notes

- Automation is opt-in via Options checkbox.
- Regular summarize flows remain unchanged.
- Tool results are treated as **data**, not instructions. The system prompt still asks the assistant to repeat important tool-derived info in plain text.
- Tool results are currently rendered in the chat UI for debugging; they may be hidden in the future.
- When the active tab URL changes during a conversation, the panel appends a **navigation tool result** with the new URL, title, and matching skills. This keeps the agent aware of user-driven navigation.
- REPL executions that call `browserjs()` show a small overlay with an **Abort** action; aborting stops the current agent loop (best-effort).

## Where Things Live

- **Daemon**: `src/daemon/server.ts`, `src/daemon/agent.ts`
- **Automation tools**: `apps/chrome-extension/src/automation/`
- **Element picker + native input bridge**: `apps/chrome-extension/src/entrypoints/automation.content.ts`
- **Background agent proxy**: `apps/chrome-extension/src/entrypoints/background.ts`
- **Side panel agent loop**: `apps/chrome-extension/src/entrypoints/sidepanel/`
- **Options toggle**: `apps/chrome-extension/src/entrypoints/options/`
