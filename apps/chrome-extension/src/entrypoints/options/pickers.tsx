import { message as uiMessage, extensionMessage } from "../../lib/i18n";
import type { ColorMode, ColorScheme } from "../../lib/theme";
import { MessageText } from "../../ui/localized-text";
import { mountComponent } from "../../ui/mount";
import { useSelect } from "../../ui/select";
import { SelectField } from "../../ui/select-field";
import { modeItems, schemeItems, SchemeChips } from "../../ui/theme";

type OptionsPickerState = {
  scheme: ColorScheme;
  mode: ColorMode;
};

type OptionsPickerHandlers = {
  onSchemeChange: (value: ColorScheme) => void;
  onModeChange: (value: ColorMode) => void;
};

type OptionsPickerProps = OptionsPickerState & OptionsPickerHandlers;

function OptionsPickers(props: OptionsPickerProps) {
  const schemeApi = useSelect({
    id: "options-scheme",
    items: schemeItems,
    value: props.scheme,
    onValueChange: (value) => {
      if (!value) return;
      props.onSchemeChange(value as ColorScheme);
    },
  });

  const modeApi = useSelect({
    id: "options-mode",
    items: modeItems,
    value: props.mode,
    onValueChange: (value) => {
      if (!value) return;
      props.onModeChange(value as ColorMode);
    },
  });

  return (
    <>
      <SelectField
        label={uiMessage("color.scheme")}
        labelClassName="scheme"
        api={schemeApi}
        matchTriggerWidth
        positionerStyle={{ pointerEvents: schemeApi.open ? "auto" : "none" }}
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
        label={uiMessage("appearance")}
        labelClassName="mode"
        api={modeApi}
        matchTriggerWidth
        positionerStyle={{ pointerEvents: modeApi.open ? "auto" : "none" }}
        items={modeItems}
        triggerContent={(label) => <span>{label || extensionMessage("system")}</span>}
        optionContent={(item) => (
          <span>
            <MessageText value={item.label} />
          </span>
        )}
      />
    </>
  );
}

export function mountOptionsPickers(root: HTMLElement, props: OptionsPickerProps) {
  return mountComponent(root, OptionsPickers, props);
}
