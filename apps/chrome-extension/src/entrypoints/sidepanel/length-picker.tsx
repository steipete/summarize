import type { SummaryLength } from "@steipete/summarize-core";
import { SUMMARY_LENGTH_SPECS } from "@steipete/summarize-core/prompts";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { readPresetOrCustomValue, resolvePresetOrCustom } from "../../lib/combo";
import { defaultSettings } from "../../lib/settings";
import { mountComponent } from "../../ui/mount";
import { type SelectItem, useSelect } from "../../ui/select";
import { SelectPopup } from "../../ui/select-field";

type SidepanelLengthPickerProps = {
  length: string;
  onLengthChange: (value: string) => void;
};

const lengthPresets = ["short", "medium", "long", "xl", "xxl", "20k"];
const MIN_CUSTOM_LENGTH_CHARS = 10;
const LENGTH_COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i;

type LengthItem = SelectItem & { tooltip?: string };

const lengthLabels: Record<SummaryLength, string> = {
  short: "Short",
  medium: "Medium",
  long: "Long",
  xl: "Extra Large (XL)",
  xxl: "Extra Extra Large (XXL)",
};

const formatCount = (value: number) => value.toLocaleString();

const formatLengthTooltip = (preset: SummaryLength): string => {
  const spec = SUMMARY_LENGTH_SPECS[preset];
  return `${lengthLabels[preset]}: target ~${formatCount(spec.targetCharacters)} chars (${formatCount(
    spec.minCharacters,
  )}-${formatCount(spec.maxCharacters)}). ${spec.formatting}`;
};

const lengthItems: LengthItem[] = [
  { value: "short", label: "Short", tooltip: formatLengthTooltip("short") },
  { value: "medium", label: "Medium", tooltip: formatLengthTooltip("medium") },
  { value: "long", label: "Long", tooltip: formatLengthTooltip("long") },
  { value: "xl", label: "XL", tooltip: formatLengthTooltip("xl") },
  { value: "xxl", label: "XXL", tooltip: formatLengthTooltip("xxl") },
  {
    value: "20k",
    label: "20k",
    tooltip: "Custom target around 20,000 characters (soft guideline).",
  },
  { value: "custom", label: "Custom…", tooltip: "Set a custom length like 1500, 20k, or 1.5k." },
];

function LengthField({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const shouldFocusCustomInputRef = useRef(false);
  const resolved = useMemo(() => resolvePresetOrCustom({ value, presets: lengthPresets }), [value]);
  const [presetValue, setPresetValue] = useState(resolved.presetValue);
  const [customValue, setCustomValue] = useState(resolved.customValue);

  useEffect(() => {
    setPresetValue(resolved.presetValue);
    setCustomValue(resolved.customValue);
  }, [resolved.customValue, resolved.presetValue]);

  const api = useSelect({
    id: "length",
    items: lengthItems,
    value: presetValue,
    onValueChange: (next) => {
      const nextValue = next || defaultSettings.length;
      setPresetValue(nextValue);
      if (nextValue === "custom") {
        shouldFocusCustomInputRef.current = true;
        return;
      }
      onValueChange(nextValue);
    },
  });

  const labelProps = api.getLabelProps();
  const resolvedLabelProps =
    presetValue === "custom"
      ? { ...labelProps, htmlFor: "lengthCustom", onClick: undefined }
      : labelProps;

  useEffect(() => {
    if (presetValue !== "custom") return;
    if (!shouldFocusCustomInputRef.current) return;
    shouldFocusCustomInputRef.current = false;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [presetValue]);

  const clampCustomLength = (raw: string) => {
    const trimmed = raw.trim();
    const match = LENGTH_COUNT_PATTERN.exec(trimmed);
    if (!match?.groups) return trimmed;
    const numeric = Number(match.groups.value);
    if (!Number.isFinite(numeric) || numeric <= 0) return trimmed;
    const unit = match.groups.unit?.toLowerCase() ?? null;
    const multiplier = unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1;
    const maxCharacters = Math.floor(numeric * multiplier);
    if (maxCharacters < MIN_CUSTOM_LENGTH_CHARS) return String(MIN_CUSTOM_LENGTH_CHARS);
    return trimmed;
  };

  const commitCustom = () => {
    const clamped = clampCustomLength(customValue);
    if (clamped !== customValue) {
      setCustomValue(clamped);
    }
    const next = readPresetOrCustomValue({
      presetValue: "custom",
      customValue: clamped,
      defaultValue: defaultSettings.length,
    });
    onValueChange(next);
  };

  const content = (
    <SelectPopup api={api} pickerId="length" variant="mini">
      {lengthItems.map((item) => (
        <button
          key={item.value}
          className="pickerOption"
          style={item.value === "custom" ? { gridColumn: "1 / -1" } : undefined}
          title={item.tooltip}
          {...api.getItemProps({ item })}
        >
          {item.label}
        </button>
      ))}
    </SelectPopup>
  );

  return (
    <label className="length mini" {...resolvedLabelProps}>
      <span className="pickerTitle">Length</span>
      <div className="combo">
        <div className="picker" {...api.getRootProps()}>
          {presetValue === "custom" ? (
            <div className="lengthCustomRow">
              <input
                ref={inputRef}
                id="lengthCustom"
                type="text"
                placeholder="Custom (e.g. 20k)"
                autocapitalize="off"
                autocomplete="off"
                spellcheck={false}
                value={customValue}
                onInput={(event) => setCustomValue(event.currentTarget.value)}
                onBlur={commitCustom}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    api.setOpen(true);
                    return;
                  }
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  commitCustom();
                }}
              />
              <button className="pickerTrigger presetsTrigger" {...api.getTriggerProps()}>
                Presets
              </button>
            </div>
          ) : (
            <button className="pickerTrigger" {...api.getTriggerProps()}>
              <span>{api.valueAsString || "Length"}</span>
            </button>
          )}
          {content}
        </div>
      </div>
    </label>
  );
}

function SidepanelLengthPicker(props: SidepanelLengthPickerProps) {
  return <LengthField value={props.length} onValueChange={props.onLengthChange} />;
}

export function mountSidepanelLengthPicker(root: HTMLElement, props: SidepanelLengthPickerProps) {
  return mountComponent(root, SidepanelLengthPicker, props);
}
