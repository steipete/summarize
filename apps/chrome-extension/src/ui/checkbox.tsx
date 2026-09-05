import { mountComponent } from "./mount";

function Checkmark() {
  return (
    <svg viewBox="0 0 16 12" aria-hidden="true">
      <path d="M2 6.5 6 10l8-8" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CheckboxField({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const state = checked ? "checked" : "unchecked";
  return (
    <label
      className="checkboxRoot"
      data-state={state}
      data-disabled={disabled ? "" : undefined}
      htmlFor={id}
    >
      <input
        id={id}
        className="checkboxInput"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span className="checkboxControl" data-state={state} aria-hidden="true">
        <span className="checkboxIndicator" data-state={state}>
          <Checkmark />
        </span>
      </span>
      <span className="checkboxLabel" data-disabled={disabled ? "" : undefined}>
        {label}
      </span>
    </label>
  );
}

export function mountCheckbox(
  root: HTMLElement,
  props: {
    id: string;
    label: string;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
  },
) {
  return mountComponent(root, CheckboxField, props);
}
