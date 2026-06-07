import type { BgToPanel, RunStart, UiState } from "../../lib/panel-contracts";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { SlidesLayout } from "../../lib/settings";
import type { PanelPhase } from "./types";

type SummarizeMode = { mode: "page" | "video"; slides: boolean };

type SidepanelTestHooks = {
  applySlidesPayload?: (payload: SseSlidesData) => void;
  getRunId?: () => string | null;
  getSummaryMarkdown?: () => string;
  getRetainedSlideSummaryMarkdown?: () => string;
  getSlideDescriptions?: () => Array<[number, string]>;
  getSlideSummaryEntries?: () => Array<[number, string]>;
  getSlideTitleEntries?: () => Array<[number, string]>;
  getPhase?: () => PanelPhase;
  getModel?: () => string | null;
  getSlidesTimeline?: () => Array<{ index: number; timestamp: number | null }>;
  getTranscriptTimedText?: () => string | null;
  getSlidesSummaryMarkdown?: () => string;
  getSlidesSummaryComplete?: () => boolean;
  getSlidesSummaryModel?: () => string | null;
  getChatEnabled?: () => boolean;
  getSettingsHydrated?: () => boolean;
  setTranscriptTimedText?: (value: string | null) => void;
  setSummarizeMode?: (payload: SummarizeMode) => Promise<void>;
  getSummarizeMode?: () => { mode: "page" | "video"; slides: boolean; mediaAvailable: boolean };
  getSlidesState?: () => { slidesCount: number; layout: SlidesLayout; hasSlides: boolean };
  renderSlidesNow?: () => void;
  applyUiState?: (state: UiState) => void;
  applyBgMessage?: (message: BgToPanel) => void;
  applySummarySnapshot?: (payload: { run: RunStart; markdown: string }) => void;
  applySummaryMarkdown?: (markdown: string) => void;
  applySlidesSummaryMarkdown?: (markdown: string) => void;
  forceRenderSlides?: () => void;
  showInlineError?: (message: string) => void;
  isInlineErrorVisible?: () => boolean;
  getInlineErrorMessage?: () => string;
};

export function registerSidepanelTestHooks(options: {
  applySlidesPayload: (payload: SseSlidesData) => void;
  getRunId: () => string | null;
  getSummaryMarkdown: () => string;
  getRetainedSlideSummaryMarkdown: () => string;
  getSlideDescriptions: () => Array<[number, string]>;
  getSlideSummaryEntries: () => Array<[number, string]>;
  getSlideTitleEntries: () => Array<[number, string]>;
  getPhase: () => PanelPhase;
  getModel: () => string | null;
  getSlidesTimeline: () => Array<{ index: number; timestamp: number | null }>;
  getTranscriptTimedText: () => string | null;
  getSlidesSummaryMarkdown: () => string;
  getSlidesSummaryComplete: () => boolean;
  getSlidesSummaryModel: () => string | null;
  getChatEnabled: () => boolean;
  getSettingsHydrated: () => boolean;
  setTranscriptTimedText: (value: string | null) => void;
  setSummarizeMode: (payload: SummarizeMode) => Promise<void>;
  getSummarizeMode: () => { mode: "page" | "video"; slides: boolean; mediaAvailable: boolean };
  getSlidesState: () => { slidesCount: number; layout: SlidesLayout; hasSlides: boolean };
  renderSlidesNow: () => void;
  applyUiState: (state: UiState) => void;
  applyBgMessage: (message: BgToPanel) => void;
  applySummarySnapshot: (payload: { run: RunStart; markdown: string }) => void;
  applySummaryMarkdown: (markdown: string) => void;
  applySlidesSummaryMarkdown: (markdown: string) => void;
  forceRenderSlides: () => void;
  showInlineError: (message: string) => void;
  isInlineErrorVisible: () => boolean;
  getInlineErrorMessage: () => string;
}) {
  const hooks = (
    globalThis as {
      __summarizeTestHooks?: SidepanelTestHooks;
    }
  ).__summarizeTestHooks;
  if (!hooks) return;

  hooks.applySlidesPayload = options.applySlidesPayload;
  hooks.getRunId = options.getRunId;
  hooks.getSummaryMarkdown = options.getSummaryMarkdown;
  hooks.getRetainedSlideSummaryMarkdown = options.getRetainedSlideSummaryMarkdown;
  hooks.getSlideDescriptions = options.getSlideDescriptions;
  hooks.getSlideSummaryEntries = options.getSlideSummaryEntries;
  hooks.getSlideTitleEntries = options.getSlideTitleEntries;
  hooks.getPhase = options.getPhase;
  hooks.getModel = options.getModel;
  hooks.getSlidesTimeline = options.getSlidesTimeline;
  hooks.getTranscriptTimedText = options.getTranscriptTimedText;
  hooks.getSlidesSummaryMarkdown = options.getSlidesSummaryMarkdown;
  hooks.getSlidesSummaryComplete = options.getSlidesSummaryComplete;
  hooks.getSlidesSummaryModel = options.getSlidesSummaryModel;
  hooks.getChatEnabled = options.getChatEnabled;
  hooks.getSettingsHydrated = options.getSettingsHydrated;
  hooks.setTranscriptTimedText = options.setTranscriptTimedText;
  hooks.setSummarizeMode = options.setSummarizeMode;
  hooks.getSummarizeMode = options.getSummarizeMode;
  hooks.getSlidesState = options.getSlidesState;
  hooks.renderSlidesNow = options.renderSlidesNow;
  hooks.applyUiState = options.applyUiState;
  hooks.applyBgMessage = options.applyBgMessage;
  hooks.applySummarySnapshot = options.applySummarySnapshot;
  hooks.applySummaryMarkdown = options.applySummaryMarkdown;
  hooks.applySlidesSummaryMarkdown = options.applySlidesSummaryMarkdown;
  hooks.forceRenderSlides = options.forceRenderSlides;
  hooks.showInlineError = options.showInlineError;
  hooks.isInlineErrorVisible = options.isInlineErrorVisible;
  hooks.getInlineErrorMessage = options.getInlineErrorMessage;
}
