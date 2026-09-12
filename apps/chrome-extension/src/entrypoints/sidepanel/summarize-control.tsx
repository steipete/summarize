import { mountComponent } from "../../ui/mount";
import { type SelectItem, useSelect } from "../../ui/select";
import { SelectPopup } from "../../ui/select-field";

type SummarizeControlProps = {
  mode: "page" | "video";
  slidesEnabled: boolean;
  mediaAvailable: boolean;
  busy?: boolean;
  videoLabel?: string;
  pageWords?: number | null;
  videoDurationSeconds?: number | null;
  slidesTextMode?: "transcript" | "ocr";
  slidesTextToggleVisible?: boolean;
  onSlidesTextModeChange?: (value: "transcript" | "ocr") => void;
  onChange: (value: { mode: "page" | "video"; slides: boolean }) => void;
  onSummarize: () => void;
};

const formatWordCount = (value: number | null | undefined) => {
  if (!value || !Number.isFinite(value)) return null;
  return `${value.toLocaleString()} words`;
};

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = minutes.toString().padStart(2, "0");
  const ss = secs.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss} min` : `${minutes}:${ss} min`;
};

function SummarizeControl(props: SummarizeControlProps) {
  const pageMeta = formatWordCount(props.pageWords);
  const videoMeta = formatDuration(props.videoDurationSeconds);

  const pageLabel = pageMeta ? `Page · ${pageMeta}` : "Page";
  const videoLabel = `${props.videoLabel ?? "Video"}${videoMeta ? ` · ${videoMeta}` : ""}`;
  const videoSlidesLabel = `${props.videoLabel ?? "Video"} + Slides`;

  const sourceItems: SelectItem[] = props.mediaAvailable
    ? [
        { value: "page", label: pageLabel },
        { value: "video", label: videoLabel },
        { value: "video-slides", label: videoSlidesLabel },
      ]
    : [{ value: "page", label: pageLabel }];
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
    api.valueAsString || sourceItems.find((item) => item.value === selectedValue)?.label || "Page";

  const content = (
    <SelectPopup api={api} pickerId="source">
      {sourceItems.map((item) => (
        <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
          {item.label}
        </button>
      ))}
    </SelectPopup>
  );

  const triggerProps = api.getTriggerProps();
  const onClick = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const hit = event.clientX - rect.left >= rect.width - 28;
    if (hit) {
      triggerProps.onClick?.(event);
      return;
    }
    if (api.open) api.setOpen(false);
    props.onSummarize();
  };
  const onPointerDown = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const hit = event.clientX - rect.left >= rect.width - 28;
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
          aria-label={`Summarize (${selectedLabel})`}
          data-busy={props.busy ? "true" : "false"}
          disabled={!props.mediaAvailable && props.mode === "video"}
          {...rest}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        >
          Summarize
        </button>
        {content}
      </div>
      {showSlidesTextToggle ? (
        <fieldset className="summarizeSlidesToggle">
          <legend className="summarizeSlidesToggle__label">Slides text source</legend>
          <button
            type="button"
            data-active={props.slidesTextMode === "transcript" ? "true" : "false"}
            onClick={() => props.onSlidesTextModeChange?.("transcript")}
          >
            Transcript
          </button>
          <button
            type="button"
            data-active={props.slidesTextMode === "ocr" ? "true" : "false"}
            onClick={() => props.onSlidesTextModeChange?.("ocr")}
          >
            OCR
          </button>
        </fieldset>
      ) : null}
    </div>
  );
}

export function mountSummarizeControl(root: HTMLElement, props: SummarizeControlProps) {
  return mountComponent(root, SummarizeControl, props);
}
