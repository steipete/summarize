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
const MIN_CUSTOM_LENGTH_CHARS = 10
const LENGTH_COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i

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
  const shouldFocusCustomInputRef = useRef(false)
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
        shouldFocusCustomInputRef.current = true
        return
      }
      onValueChange(nextValue)
    },
  })

  const labelProps = api.getLabelProps()
  const resolvedLabelProps =
    presetValue === 'custom'
      ? { ...labelProps, htmlFor: 'lengthCustom', onClick: undefined }
      : labelProps

  useEffect(() => {
    if (presetValue !== 'custom') return
    if (!shouldFocusCustomInputRef.current) return
    shouldFocusCustomInputRef.current = false
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [presetValue])

  const clampCustomLength = (raw: string) => {
    const trimmed = raw.trim()
    const match = LENGTH_COUNT_PATTERN.exec(trimmed)
    if (!match?.groups) return trimmed
    const numeric = Number(match.groups.value)
    if (!Number.isFinite(numeric) || numeric <= 0) return trimmed
    const unit = match.groups.unit?.toLowerCase() ?? null
    const multiplier = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1
    const maxCharacters = Math.floor(numeric * multiplier)
    if (maxCharacters < MIN_CUSTOM_LENGTH_CHARS) return String(MIN_CUSTOM_LENGTH_CHARS)
    return trimmed
  }

  const commitCustom = () => {
    const clamped = clampCustomLength(customValue)
    if (clamped !== customValue) {
      setCustomValue(clamped)
    }
    const next = readPresetOrCustomValue({
      presetValue: 'custom',
      customValue: clamped,
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
    <div
      className="pickerPositioner"
      data-picker="length"
      data-variant={variant}
      {...positionerProps}
      style={positionerStyle}
    >
      <div className="pickerContent" {...api.getContentProps()}>
        <div className="pickerList" {...api.getListProps()}>
          {lengthItems.map((item) => (
            <button
              key={item.value}
              className="pickerOption"
              style={item.value === 'custom' ? { gridColumn: '1 / -1' } : undefined}
              {...api.getItemProps({ item })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <label className={variant === 'mini' ? 'length mini' : 'length wide'} {...resolvedLabelProps}>
      <span className="pickerTitle">Length</span>
      <div className="combo">
        <div className="picker" {...api.getRootProps()}>
          {presetValue === 'custom' ? (
            <div className="lengthCustomRow">
              <input
                ref={inputRef}
                id="lengthCustom"
                type="text"
                placeholder="Custom (e.g. 20k)"
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                value={customValue}
                onInput={(event) => setCustomValue(event.currentTarget.value)}
                onBlur={commitCustom}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    api.setOpen(true)
                    return
                  }
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  commitCustom()
                }}
              />
              <button className="pickerTrigger presetsTrigger" {...api.getTriggerProps()}>
                Presets
              </button>
            </div>
          ) : (
            <button className="pickerTrigger" {...api.getTriggerProps()}>
              <span>{api.valueAsString || 'Length'}</span>
            </button>
          )}
          {portalRoot ? createPortal(content, portalRoot) : content}
          <select className="pickerHidden" {...api.getHiddenSelectProps()} />
        </div>
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
        triggerContent={(label, value) => (
          <span style={value ? { fontFamily: value } : undefined}>{label || 'SF'}</span>
        )}
        optionContent={(item) => <span style={{ fontFamily: item.value }}>{item.label}</span>}
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
