import { render } from 'preact'
import { createPortal } from 'preact/compat'

import type { ColorMode, ColorScheme } from '../../lib/theme'
import { getOverlayRoot } from '../../ui/portal'
import { SchemeChips } from '../../ui/scheme-chips'
import { type SelectItem, useZagSelect } from '../../ui/zag-select'

type OptionsPickerState = {
  scheme: ColorScheme
  mode: ColorMode
}

type OptionsPickerHandlers = {
  onSchemeChange: (value: ColorScheme) => void
  onModeChange: (value: ColorMode) => void
}

type OptionsPickerProps = OptionsPickerState & OptionsPickerHandlers

const schemeItems: SelectItem[] = [
  { value: 'slate', label: 'Slate' },
  { value: 'cedar', label: 'Cedar' },
  { value: 'mint', label: 'Mint' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'ember', label: 'Ember' },
  { value: 'iris', label: 'Iris' },
]

const modeItems: SelectItem[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function SelectField({
  label,
  labelClassName,
  api,
  triggerContent,
  optionContent,
  items,
}: {
  label: string
  labelClassName: string
  api: ReturnType<typeof useZagSelect>
  triggerContent: (selectedLabel: string, selectedValue: string) => JSX.Element
  optionContent: (item: SelectItem) => JSX.Element
  items: SelectItem[]
}) {
  const selectedValue = api.value[0] ?? ''
  const selectedLabel =
    api.valueAsString || items.find((item) => item.value === selectedValue)?.label || ''
  const portalRoot = getOverlayRoot()
  const positionerProps = api.getPositionerProps()
  const positionerStyle = {
    ...(positionerProps.style ?? {}),
    position: 'fixed',
    zIndex: 9999,
  }
  const content = (
    <div className="pickerPositioner" {...positionerProps} style={positionerStyle}>
      <div className="pickerContent" {...api.getContentProps()}>
        <div className="pickerList" {...api.getListProps()}>
          {items.map((item) => (
            <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
              {optionContent(item)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <label className={labelClassName} {...api.getLabelProps()}>
      <span className="pickerTitle">{label}</span>
      <div className="picker" {...api.getRootProps()}>
        <button className="pickerTrigger" {...api.getTriggerProps()}>
          {triggerContent(selectedLabel, selectedValue)}
        </button>
        {portalRoot ? createPortal(content, portalRoot) : content}
        <select className="pickerHidden" {...api.getHiddenSelectProps()} />
      </div>
    </label>
  )
}

function OptionsPickers(props: OptionsPickerProps) {
  const schemeApi = useZagSelect({
    id: 'options-scheme',
    items: schemeItems,
    value: props.scheme,
    onValueChange: (value) => {
      if (!value) return
      props.onSchemeChange(value as ColorScheme)
    },
  })

  const modeApi = useZagSelect({
    id: 'options-mode',
    items: modeItems,
    value: props.mode,
    onValueChange: (value) => {
      if (!value) return
      props.onModeChange(value as ColorMode)
    },
  })

  return (
    <>
      <SelectField
        label="Color scheme"
        labelClassName="scheme"
        api={schemeApi}
        items={schemeItems}
        triggerContent={(label, value) => (
          <>
            <span className="scheme-label">{label || 'Slate'}</span>
            <SchemeChips scheme={value || 'slate'} />
          </>
        )}
        optionContent={(item) => (
          <>
            <span className="scheme-label">{item.label}</span>
            <SchemeChips scheme={item.value} />
          </>
        )}
      />
      <SelectField
        label="Appearance"
        labelClassName="mode"
        api={modeApi}
        items={modeItems}
        triggerContent={(label) => <span>{label || 'System'}</span>}
        optionContent={(item) => <span>{item.label}</span>}
      />
    </>
  )
}

export function mountOptionsPickers(root: HTMLElement, props: OptionsPickerProps) {
  let current = props
  const renderPickers = () => {
    render(<OptionsPickers {...current} />, root)
  }

  renderPickers()

  return {
    update(next: OptionsPickerProps) {
      current = next
      renderPickers()
    },
  }
}
