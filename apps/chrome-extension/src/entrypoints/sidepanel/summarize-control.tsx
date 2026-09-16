import { extensionMessage, message as uiMessage, resolveText, uiNumber } from "../../lib/i18n";
import { MessageText } from "../../ui/localized-text";
import { mountComponent } from "../../ui/mount";
import { type SelectItem, useSelect } from "../../ui/select";
import { SelectPopup } from "../../ui/select-field";

type SummarizeControlProps = {
  mode: "page" | "video";
  slidesEnabled: boolean;
  mediaAvailable: boolean;
  busy?: boolean;
  mediaKind?: "audio" | "video";
  pageWords?: number | null;
  videoDurationSeconds?: number | null;
  slidesTextMode?: "transcript" | "ocr";
  slidesTextToggleVisible?: boolean;
  onSlidesTextModeChange?: (value: "transcript" | "ocr") => void;
  onChange: (value: { mode: "page" | "video"; slides: boolean }) => void;
  onSummarize: () => void;
};

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = uiNumber(minutes, { minimumIntegerDigits: 2, useGrouping: false });
  const ss = uiNumber(secs, { minimumIntegerDigits: 2, useGrouping: false });
  return hours > 0
    ? `${uiNumber(hours, { useGrouping: false })}:${mm}:${ss}`
    : `${uiNumber(minutes, { useGrouping: false })}:${ss}`;
};

function SummarizeControl(props: SummarizeControlProps) {
  const videoMeta = formatDuration(props.videoDurationSeconds);
  const pageLabel = uiMessage("source.page", {
    count: props.pageWords ?? 0,
    hasCount: Boolean(props.pageWords),
  });
  const videoLabel = uiMessage("source.media", {
    kind: props.mediaKind ?? "video",
    duration: videoMeta ?? "",
    hasDuration: Boolean(videoMeta),
  });
  const videoSlidesLabel = uiMessage("source.mediaSlides", { kind: props.mediaKind ?? "video" });

  const sourceItems: SelectItem[] = props.mediaAvailable
    ? [
        {
          // i18n-ignore: Stored source mode; the label is a separate message descriptor.
          value: "page",
          label: pageLabel,
        },
        {
          // i18n-ignore: Stored source mode; the label is a separate message descriptor.
          value: "video",
          label: videoLabel,
        },
        {
          // i18n-ignore: Stored source mode; the label is a separate message descriptor.
          value: "video-slides",
          label: videoSlidesLabel,
        },
      ]
    : [
        {
          // i18n-ignore: Stored source mode; the label is a separate message descriptor.
          value: "page",
          label: pageLabel,
        },
      ];
  const api = useSelect({
    id: "source",
    items: sourceItems,
    value: props.slidesEnabled ? "video-slides" : props.mode,
    onValueChange: (next) => {
      if (next === "video-slides") {
        props.onChange({ mode: "video", slides: true });
      } else if (next === "video") {
        props.onChange({ mode: "video", slides: false });
      } else {
        props.onChange({ mode: "page", slides: false });
      }
    },
  });

  const selectedValue = api.value[0] ?? "";
  const selectedLabel =
    api.valueAsString ||
    resolveText(
      sourceItems.find((item) => item.value === selectedValue)?.label || uiMessage("page"),
    );

  const content = (
    <SelectPopup api={api} pickerId="source">
      {sourceItems.map((item) => (
        <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
          <MessageText value={item.label} />
        </button>
      ))}
    </SelectPopup>
  );

  const triggerProps = api.getTriggerProps();
  const onClick = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const inlinePosition = event.clientX - rect.left;
    const hit =
      getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl"
        ? inlinePosition < 28
        : inlinePosition >= rect.width - 28;
    if (hit) {
      triggerProps.onClick?.(event);
      return;
    }
    if (api.open) api.setOpen(false);
    props.onSummarize();
  };
  const onPointerDown = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const inlinePosition = event.clientX - rect.left;
    const hit =
      getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl"
        ? inlinePosition < 28
        : inlinePosition >= rect.width - 28;
    if (hit) {
      triggerProps.onPointerDown?.(event);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      api.setOpen(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSummarize();
      return;
    }
    triggerProps.onKeyDown?.(event);
  };
  const {
    onClick: _onClick,
    onPointerDown: _onPointerDown,
    onKeyDown: _onKeyDown,
    ...rest
  } = triggerProps;

  const showSlidesTextToggle = Boolean(
    props.slidesEnabled &&
    props.slidesTextToggleVisible &&
    props.slidesTextMode &&
    props.onSlidesTextModeChange,
  );

  return (
    <div className="summarizeControlGroup">
      <div className="picker summarizePicker" {...api.getRootProps()}>
        <button
          className="ghost summarizeButton isDropdown"
          aria-label={extensionMessage("source.summarizeAction", { source: selectedLabel })}
          data-busy={props.busy ? "true" : "false"}
          disabled={!props.mediaAvailable && props.mode === "video"}
          {...rest}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        >
          {extensionMessage("summarize")}
        </button>
        {content}
      </div>
      {showSlidesTextToggle ? (
        <fieldset className="summarizeSlidesToggle">
          <legend className="summarizeSlidesToggle__label">
            {extensionMessage("slides.text.source")}
          </legend>
          <button
            type="button"
            data-active={props.slidesTextMode === "transcript" ? "true" : "false"}
            onClick={() => props.onSlidesTextModeChange?.("transcript")}
          >
            {extensionMessage("transcript")}
          </button>
          <button
            type="button"
            data-active={props.slidesTextMode === "ocr" ? "true" : "false"}
            onClick={() => props.onSlidesTextModeChange?.("ocr")}
          >
            {extensionMessage("ocr")}
          </button>
        </fieldset>
      ) : null}
    </div>
  );
}

export function mountSummarizeControl(root: HTMLElement, props: SummarizeControlProps) {
  return mountComponent(root, SummarizeControl, props);
}
