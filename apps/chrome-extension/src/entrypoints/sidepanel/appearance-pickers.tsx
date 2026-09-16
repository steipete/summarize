import type { JSX } from "preact";
import { message as uiMessage, extensionMessage } from "../../lib/i18n";
import type { ColorMode, ColorScheme } from "../../lib/theme";
import { MessageText } from "../../ui/localized-text";
import { mountComponent } from "../../ui/mount";
import { type SelectItem, useSelect } from "../../ui/select";
import { SelectField } from "../../ui/select-field";
import { modeItems, schemeItems, SchemeChips } from "../../ui/theme";

type SidepanelPickerState = {
  scheme: ColorScheme;
  mode: ColorMode;
  fontFamily: string;
};

type SidepanelPickerHandlers = {
  onSchemeChange: (value: ColorScheme) => void;
  onModeChange: (value: ColorMode) => void;
  onFontChange: (value: string) => void;
};

type SidepanelPickerProps = SidepanelPickerState & SidepanelPickerHandlers;

const modeIcons: Record<string, JSX.Element> = {
  system: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="4"
        y="5"
        width="16"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M8 19h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 16v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  light: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 3.5v2.5M12 18v2.5M3.5 12h2.5M18 12h2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.5 15a7.5 7.5 0 1 1-10-10 6.2 6.2 0 0 0 10 10Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

// i18n-ignore: CSS font-family identifiers; displayed labels are keyed or font names.
const fontItems: SelectItem[] = [
  {
    value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    label: uiMessage("san.francisco"),
  },
  { value: "Georgia, serif", label: "Georgia" },
  { value: "Iowan Old Style, Palatino, serif", label: "Iowan" },
  {
    value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    label: "Mono",
  },
];

function SidepanelPickers(props: SidepanelPickerProps) {
  const schemeApi = useSelect({
    id: "scheme",
    items: schemeItems,
    value: props.scheme,
    onValueChange: (value) => {
      if (!value) return;
      props.onSchemeChange(value as ColorScheme);
    },
  });

  const modeApi = useSelect({
    id: "mode",
    items: modeItems,
    value: props.mode,
    onValueChange: (value) => {
      if (!value) return;
      props.onModeChange(value as ColorMode);
    },
  });

  const fontApi = useSelect({
    id: "font",
    items: fontItems,
    value: props.fontFamily,
    onValueChange: (value) => {
      if (!value) return;
      props.onFontChange(value);
    },
  });

  return (
    <>
      <SelectField
        label={uiMessage("scheme")}
        labelClassName="scheme"
        pickerId="scheme"
        api={schemeApi}
        items={schemeItems}
        triggerContent={(label, value) => (
          <>
            <span className="scheme-label">{label || extensionMessage("slate")}</span>
            <SchemeChips scheme={value || "slate"} />
          </>
        )}
        optionContent={(item) => (
          <>
            <span className="scheme-label">
              <MessageText value={item.label} />
            </span>
            <SchemeChips scheme={item.value} />
          </>
        )}
      />
      <SelectField
        label={uiMessage("mode")}
        labelClassName="mode"
        pickerId="mode"
        api={modeApi}
        items={modeItems}
        triggerContent={(label, value) => (
          <>
            <span>{label || extensionMessage("system")}</span>
            <span className="modeIcon">{modeIcons[value] ?? null}</span>
          </>
        )}
        optionContent={(item) => (
          <>
            <span>
              <MessageText value={item.label} />
            </span>
            <span className="modeIcon">{modeIcons[item.value] ?? null}</span>
          </>
        )}
      />
      <SelectField
        label={uiMessage("font")}
        labelClassName="font"
        pickerId="font"
        api={fontApi}
        items={fontItems}
        triggerContent={(label, value) => (
          <span style={value ? { fontFamily: value } : undefined}>
            {label || extensionMessage("san.francisco")}
          </span>
        )}
        optionContent={(item) => (
          <span style={{ fontFamily: item.value }}>
            <MessageText value={item.label} />
          </span>
        )}
      />
    </>
  );
}

export function mountSidepanelPickers(root: HTMLElement, props: SidepanelPickerProps) {
  return mountComponent(root, SidepanelPickers, props);
}
