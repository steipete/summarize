import type { LocalizedText } from "../../lib/i18n";
import { mountCheckbox } from "../../ui/checkbox";

type BooleanToggleArgs = {
  root: HTMLElement;
  id: string;
  label: LocalizedText;
  getValue: () => boolean;
  setValue: (checked: boolean) => void;
  scheduleAutoSave: (delay?: number) => void;
  afterChange?: () => void | Promise<void>;
};

export function createBooleanToggleController({
  root,
  id,
  label,
  getValue,
  setValue,
  scheduleAutoSave,
  afterChange,
}: BooleanToggleArgs) {
  const renderProps = () => ({
    id,
    label,
    checked: getValue(),
    onCheckedChange: (checked: boolean) => {
      setValue(checked);
      toggle.update(renderProps());
      scheduleAutoSave(0);
      void afterChange?.();
    },
  });

  const toggle = mountCheckbox(root, renderProps());

  return {
    render() {
      toggle.update(renderProps());
    },
  };
}
