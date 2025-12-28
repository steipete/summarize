import { render } from 'preact'
import { createPortal } from 'preact/compat'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { readPresetOrCustomValue, resolvePresetOrCustom } from '../../lib/combo'
import { defaultSettings } from '../../lib/settings'
import type { ColorMode, ColorScheme } from '../../lib/theme'
import { getOverlayRoot } from '../../ui/portal'
import { SchemeChips } from '../../ui/scheme-chips'
import { type SelectItem, useZagSelect } from '../../ui/zag-select'

type SidepanelPickerState = {
  scheme: ColorScheme
  mode: ColorMode
  fontFamily: string
}

type SidepanelPickerHandlers = {
  onSchemeChange: (value: ColorScheme) => void
  onModeChange: (value: ColorMode) => void
  onFontChange: (value: string) => void
}

type SidepanelPickerProps = SidepanelPickerState & SidepanelPickerHandlers

type SidepanelLengthPickerProps = {
  length: string
  onLengthChange: (value: string) => void
}

const lengthPresets = ['short', 'medium', 'long', 'xl', 'xxl', '20k']

const lengthItems: SelectItem[] = [
  { value: 'short', label: 'Short' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long' },
  { value: 'xl', label: 'XL' },
  { value: 'xxl', label: 'XXL' },
  { value: '20k', label: '20k' },
  { value: 'custom', label: 'Custom…' },
]

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

const fontItems: SelectItem[] = [
  {
    value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    label: 'SF',
  },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Iowan Old Style, Palatino, serif', label: 'Iowan' },
  {
    value: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    label: 'Mono',
  },
]

function SelectField({
  label,
  labelClassName,
  titleClassName,
  api,
  triggerContent,
  optionContent,
  items,
}: {
  label: string
  labelClassName: string
  titleClassName?: string
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
      <span className={titleClassName ?? 'pickerTitle'}>{label}</span>
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

function LengthField({
  value,
  onValueChange,
  variant = 'grid',
}: {
  value: string
  onValueChange: (value: string) => void
  variant?: 'grid' | 'mini'
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const resolved = useMemo(() => resolvePresetOrCustom({ value, presets: lengthPresets }), [value])
  const [presetValue, setPresetValue] = useState(resolved.presetValue)
  const [customValue, setCustomValue] = useState(resolved.customValue)
  const portalRoot = getOverlayRoot()

  useEffect(() => {
    setPresetValue(resolved.presetValue)
    setCustomValue(resolved.customValue)
  }, [resolved.customValue, resolved.presetValue])

  const api = useZagSelect({
    id: 'length',
    items: lengthItems,
    value: presetValue,
    onValueChange: (next) => {
      const nextValue = next || defaultSettings.length
      setPresetValue(nextValue)
      if (nextValue === 'custom') {
        requestAnimationFrame(() => inputRef.current?.focus())
        return
      }
      onValueChange(nextValue)
    },
  })

  const commitCustom = () => {
    const next = readPresetOrCustomValue({
      presetValue: 'custom',
      customValue,
      defaultValue: defaultSettings.length,
    })
    onValueChange(next)
  }

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
          {lengthItems.map((item) => (
            <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <label className={variant === 'mini' ? 'length mini' : 'length wide'} {...api.getLabelProps()}>
      {variant !== 'mini' ? <span className="pickerTitle">Length</span> : null}
      <div className="combo">
        <div className="picker" {...api.getRootProps()}>
          <button className="pickerTrigger" {...api.getTriggerProps()}>
            <span>{api.valueAsString || 'Length'}</span>
          </button>
          {portalRoot ? createPortal(content, portalRoot) : content}
          <select className="pickerHidden" {...api.getHiddenSelectProps()} />
        </div>
        <input
          ref={inputRef}
          id="lengthCustom"
          type="text"
          placeholder="Custom (e.g. 20k)"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          hidden={presetValue !== 'custom'}
          value={customValue}
          onInput={(event) => setCustomValue(event.currentTarget.value)}
          onBlur={commitCustom}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitCustom()
          }}
        />
      </div>
    </label>
  )
}

function SidepanelPickers(props: SidepanelPickerProps) {
  const schemeApi = useZagSelect({
    id: 'scheme',
    items: schemeItems,
    value: props.scheme,
    onValueChange: (value) => {
      if (!value) return
      props.onSchemeChange(value as ColorScheme)
    },
  })

  const modeApi = useZagSelect({
    id: 'mode',
    items: modeItems,
    value: props.mode,
    onValueChange: (value) => {
      if (!value) return
      props.onModeChange(value as ColorMode)
    },
  })

  const fontApi = useZagSelect({
    id: 'font',
    items: fontItems,
    value: props.fontFamily,
    onValueChange: (value) => {
      if (!value) return
      props.onFontChange(value)
    },
  })

  return (
    <>
      <SelectField
        label="Scheme"
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
        label="Mode"
        labelClassName="mode"
        api={modeApi}
        items={modeItems}
        triggerContent={(label) => <span>{label || 'System'}</span>}
        optionContent={(item) => <span>{item.label}</span>}
      />
      <SelectField
        label="Font"
        labelClassName="font"
        api={fontApi}
        items={fontItems}
        triggerContent={(label) => <span>{label || 'SF'}</span>}
        optionContent={(item) => <span>{item.label}</span>}
      />
    </>
  )
}

export function mountSidepanelPickers(root: HTMLElement, props: SidepanelPickerProps) {
  let current = props
  const renderPickers = () => {
    render(<SidepanelPickers {...current} />, root)
  }

  renderPickers()

  return {
    update(next: SidepanelPickerProps) {
      current = next
      renderPickers()
    },
  }
}

function SidepanelLengthPicker(props: SidepanelLengthPickerProps) {
  return <LengthField variant="mini" value={props.length} onValueChange={props.onLengthChange} />
}

export function mountSidepanelLengthPicker(root: HTMLElement, props: SidepanelLengthPickerProps) {
  let current = props
  const renderPicker = () => {
    render(<SidepanelLengthPicker {...current} />, root)
  }

  renderPicker()

  return {
    update(next: SidepanelLengthPickerProps) {
      current = next
      renderPicker()
    },
  }
}
