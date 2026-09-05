import type { ComponentChildren, JSX } from "preact";
import { createPortal } from "preact/compat";
import { getOverlayRoot } from "./portal";
import type { SelectItem, useSelect } from "./select";

type PopupProps = {
  api: ReturnType<typeof useSelect>;
  pickerId?: string;
  variant?: string;
  matchTriggerWidth?: boolean;
  positionerStyle?: JSX.CSSProperties;
};

export function SelectPopup({
  api,
  pickerId,
  variant,
  matchTriggerWidth = false,
  positionerStyle,
  children,
}: PopupProps & { children: ComponentChildren }) {
  const portalRoot = getOverlayRoot();
  const positionerProps = api.getPositionerProps();
  const style = { ...positionerProps.style, position: "fixed", zIndex: 9999 };
  if (!matchTriggerWidth) {
    delete style.width;
    delete style.maxWidth;
  }
  const content = (
    <div
      className="pickerPositioner"
      data-picker={pickerId}
      data-variant={variant}
      {...positionerProps}
      style={{ ...style, ...positionerStyle }}
    >
      <div className="pickerContent" {...api.getContentProps()}>
        <div className="pickerList" {...api.getListProps()}>
          {children}
        </div>
      </div>
    </div>
  );
  return portalRoot ? createPortal(content, portalRoot) : content;
}

export function SelectField({
  label,
  labelClassName,
  api,
  triggerContent,
  optionContent,
  items,
  ...popupProps
}: PopupProps & {
  label: string;
  labelClassName: string;
  triggerContent: (label: string, value: string) => JSX.Element;
  optionContent: (item: SelectItem) => JSX.Element;
  items: SelectItem[];
}) {
  const selectedValue = api.value[0] ?? "";
  const selectedLabel =
    api.valueAsString || items.find((item) => item.value === selectedValue)?.label || "";
  return (
    <label className={labelClassName} {...api.getLabelProps()}>
      <span className="pickerTitle">{label}</span>
      <div className="picker" {...api.getRootProps()}>
        <button className="pickerTrigger" {...api.getTriggerProps()}>
          {triggerContent(selectedLabel, selectedValue)}
        </button>
        <SelectPopup api={api} {...popupProps}>
          {items.map((item) => (
            <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
              {optionContent(item)}
            </button>
          ))}
        </SelectPopup>
      </div>
    </label>
  );
}
