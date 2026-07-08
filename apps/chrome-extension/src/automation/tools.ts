import type {
  AgentToolCall as ToolCall,
  AgentToolResultMessage as ToolResultMessage,
} from "@steipete/summarize-core/runtime";
import { hasDebuggerCapability } from "../lib/automation-capabilities";
import { executeAskUserWhichElementTool } from "./ask-user-which-element";
import { executeNavigateTool } from "./navigate";
import { executeReplTool } from "./repl";
import { executeSkillTool, type SkillToolArgs } from "./skills";
import { getActiveTabUrl } from "./tools/active-tab";
import { executeArtifactsTool, type ArtifactsToolArgs } from "./tools/artifacts";
import { executeDebuggerTool } from "./tools/debugger";
import { executeSummarizeTool, type SummarizeToolArgs } from "./tools/summarize";

const TOOL_NAMES = [
  "navigate",
  "repl",
  "ask_user_which_element",
  "skill",
  "artifacts",
  "summarize",
  "debugger",
] as const;

export type AutomationToolName = (typeof TOOL_NAMES)[number];

export function getAutomationToolNames(): AutomationToolName[] {
  return TOOL_NAMES.filter((name) => name !== "debugger" || hasDebuggerCapability());
}

function buildToolResultMessage({
  toolCallId,
  toolName,
  text,
  isError,
  details,
}: {
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
  details?: unknown;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

function maybeNotifyUserScriptsNotice(message: string) {
  if (typeof window === "undefined" || !/user scripts|userscripts/i.test(message)) return;
  window.dispatchEvent(
    new CustomEvent("summarize:automation-permissions", {
      detail: {
        title: "User Scripts required",
        message,
        ctaLabel: "Open extension details",
        ctaAction: "extensions",
      },
    }),
  );
}

export async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    if (toolCall.name === "navigate") {
      const result = await executeNavigateTool(
        toolCall.arguments as {
          url?: string;
          newTab?: boolean;
          listTabs?: boolean;
          switchToTab?: number;
        },
      );
      let text = "";
      if (result.tabs) {
        text =
          result.tabs.length === 0
            ? "No open tabs."
            : result.tabs
                .map((tab) => `- [${tab.id}] ${tab.title ?? "Untitled"} (${tab.url ?? "no url"})`)
                .join("\n");
      } else if (typeof result.switchedToTab === "number") {
        text = `Switched to tab ${result.switchedToTab}${result.finalUrl ? `: ${result.finalUrl}` : ""}`;
      } else {
        text = `Navigated to ${result.finalUrl ?? "unknown url"}`;
      }

      if (result.skills && result.skills.length > 0) {
        const skillLines = result.skills.map(
          (skill) => `- ${skill.name}: ${skill.shortDescription}`,
        );
        text = `${text}\n\nSkills:\n${skillLines.join("\n")}`;
      }
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text,
        isError: false,
        details: result,
      });
    }

    if (toolCall.name === "repl") {
      const result = await executeReplTool(toolCall.arguments as { title: string; code: string });
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.output,
        isError: false,
        details: result.files?.length ? { files: result.files } : undefined,
      });
    }

    if (toolCall.name === "ask_user_which_element") {
      const result = await executeAskUserWhichElementTool(
        toolCall.arguments as { message?: string },
      );
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: `Selected ${result.selector}`,
        isError: false,
        details: result,
      });
    }

    if (toolCall.name === "skill") {
      const result = await executeSkillTool(toolCall.arguments as SkillToolArgs, getActiveTabUrl);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "debugger") {
      const result = await executeDebuggerTool(
        toolCall.arguments as { action?: string; code?: string },
      );
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "summarize") {
      const result = await executeSummarizeTool(toolCall.arguments as SummarizeToolArgs);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "artifacts") {
      const result = await executeArtifactsTool(toolCall.arguments as ArtifactsToolArgs);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    return buildToolResultMessage({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Unknown tool: ${toolCall.name}`,
      isError: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (toolCall.name === "repl") maybeNotifyUserScriptsNotice(message);
    return buildToolResultMessage({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: message,
      isError: true,
    });
  }
}
