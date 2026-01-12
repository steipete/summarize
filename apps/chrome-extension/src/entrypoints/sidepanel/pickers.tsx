import type { SummaryLength } from '@steipete/summarize-core'
import { SUMMARY_LENGTH_SPECS } from '@steipete/summarize-core/prompts'
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

type SummarizeControlProps = {
  mode: 'page' | 'video'
  slidesEnabled: boolean
  mediaAvailable: boolean
  busy?: boolean
  videoLabel?: string
  pageWords?: number | null
  videoDurationSeconds?: number | null
  onChange: (value: { mode: 'page' | 'video'; slides: boolean }) => void
  onSummarize: () => void
}

const lengthPresets = ['short', 'medium', 'long', 'xl', 'xxl', '20k']
const MIN_CUSTOM_LENGTH_CHARS = 10
const LENGTH_COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i

type LengthItem = SelectItem & { tooltip?: string }

const lengthLabels: Record<SummaryLength, string> = {
  short: 'Short',
  medium: 'Medium',
  long: 'Long',
  xl: 'Extra Large (XL)',
  xxl: 'Extra Extra Large (XXL)',
}

const formatCount = (value: number) => value.toLocaleString()

const formatWordCount = (value: number | null | undefined) => {
  if (!value || !Number.isFinite(value)) return null
  return `${formatCount(value)} words`
}

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || !Number.isFinite(seconds)) return null
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = minutes.toString().padStart(2, '0')
  const ss = secs.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss} min` : `${minutes}:${ss} min`
}

const formatLengthTooltip = (preset: SummaryLength): string => {
  const spec = SUMMARY_LENGTH_SPECS[preset]
  return `${lengthLabels[preset]}: target ~${formatCount(spec.targetCharacters)} chars (${formatCount(
    spec.minCharacters
  )}-${formatCount(spec.maxCharacters)}). ${spec.formatting}`
}

const lengthItems: LengthItem[] = [
  { value: 'short', label: 'Short', tooltip: formatLengthTooltip('short') },
  { value: 'medium', label: 'Medium', tooltip: formatLengthTooltip('medium') },
  { value: 'long', label: 'Long', tooltip: formatLengthTooltip('long') },
  { value: 'xl', label: 'XL', tooltip: formatLengthTooltip('xl') },
  { value: 'xxl', label: 'XXL', tooltip: formatLengthTooltip('xxl') },
  {
    value: '20k',
    label: '20k',
    tooltip: 'Custom target around 20,000 characters (soft guideline).',
  },
  { value: 'custom', label: 'Custom…', tooltip: 'Set a custom length like 1500, 20k, or 1.5k.' },
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
}

const fontItems: SelectItem[] = [
  {
    value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
    label: 'San Francisco',
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
  pickerId,
  api,
  triggerContent,
  optionContent,
  items,
}: {
  label: string
  labelClassName: string
  titleClassName?: string
  pickerId?: string
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
  if ('width' in positionerStyle) delete positionerStyle.width
  if ('maxWidth' in positionerStyle) delete positionerStyle.maxWidth
  const content = (
    <div
      className="pickerPositioner"
      data-picker={pickerId}
      {...positionerProps}
      style={positionerStyle}
    >
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
  if ('width' in positionerStyle) delete positionerStyle.width
  if ('maxWidth' in positionerStyle) delete positionerStyle.maxWidth
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
              title={item.tooltip}
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
        pickerId="scheme"
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
        pickerId="mode"
        api={modeApi}
        items={modeItems}
        triggerContent={(label, value) => (
          <>
            <span>{label || 'System'}</span>
            <span className="modeIcon">{modeIcons[value] ?? null}</span>
          </>
        )}
        optionContent={(item) => (
          <>
            <span>{item.label}</span>
            <span className="modeIcon">{modeIcons[item.value] ?? null}</span>
          </>
        )}
      />
      <SelectField
        label="Font"
        labelClassName="font"
        pickerId="font"
        api={fontApi}
        items={fontItems}
        triggerContent={(label, value) => (
          <span style={value ? { fontFamily: value } : undefined}>{label || 'San Francisco'}</span>
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

function SummarizeControl(props: SummarizeControlProps) {
  const pageMeta = formatWordCount(props.pageWords)
  const videoMeta = formatDuration(props.videoDurationSeconds)

  const pageLabel = pageMeta ? `Page · ${pageMeta}` : 'Page'
  const videoLabel = `${props.videoLabel ?? 'Video'}${videoMeta ? ` · ${videoMeta}` : ''}`
  const videoSlidesLabel = `${props.videoLabel ?? 'Video'} + Slides`

  const sourceItems: SelectItem[] = props.mediaAvailable
    ? [
        { value: 'page', label: pageLabel },
        { value: 'video', label: videoLabel },
        { value: 'video-slides', label: videoSlidesLabel },
      ]
    : [{ value: 'page', label: pageLabel }]
  const portalRoot = getOverlayRoot()
  const api = useZagSelect({
    id: 'source',
    items: sourceItems,
    value: props.slidesEnabled ? ['video-slides'] : [props.mode],
    onValueChange: (next) => {
      const raw = Array.isArray(next) ? next[0] : next
      if (raw === 'video-slides') {
        props.onChange({ mode: 'video', slides: true })
      } else if (raw === 'video') {
        props.onChange({ mode: 'video', slides: false })
      } else {
        props.onChange({ mode: 'page', slides: false })
      }
    },
  })

  const selectedValue = api.value[0] ?? ''
  const selectedLabel =
    api.valueAsString || sourceItems.find((item) => item.value === selectedValue)?.label || 'Page'

  const positionerProps = api.getPositionerProps()
  const positionerStyle = {
    ...(positionerProps.style ?? {}),
    position: 'fixed',
    zIndex: 9999,
  }
  if ('width' in positionerStyle) delete positionerStyle.width
  if ('maxWidth' in positionerStyle) delete positionerStyle.maxWidth
  const content = (
    <div
      className="pickerPositioner"
      data-picker="source"
      {...positionerProps}
      style={positionerStyle}
    >
      <div className="pickerContent" {...api.getContentProps()}>
        <div className="pickerList" {...api.getListProps()}>
          {sourceItems.map((item) => (
            <button key={item.value} className="pickerOption" {...api.getItemProps({ item })}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )

  const triggerProps = api.getTriggerProps()
  const onClick = (event: MouseEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const hit = event.clientX - rect.left >= rect.width - 28
    if (hit) {
      triggerProps.onClick?.(event)
      return
    }
    if (api.open) api.setOpen(false)
    props.onSummarize()
  }
  const onPointerDown = (event: PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const hit = event.clientX - rect.left >= rect.width - 28
    if (hit) {
      triggerProps.onPointerDown?.(event)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      api.setOpen(true)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      props.onSummarize()
      return
    }
    triggerProps.onKeyDown?.(event)
  }
  const {
    onClick: _onClick,
    onPointerDown: _onPointerDown,
    onKeyDown: _onKeyDown,
    ...rest
  } = triggerProps

  return (
    <div className="summarizeControlGroup">
      <div className="picker summarizePicker" {...api.getRootProps()}>
        <button
          type="button"
          className="ghost summarizeButton isDropdown"
          aria-label={`Summarize (${selectedLabel})`}
          data-busy={props.busy ? 'true' : 'false'}
          disabled={!props.mediaAvailable && props.mode === 'video'}
          {...rest}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        >
          Summarize
        </button>
        {portalRoot ? createPortal(content, portalRoot) : content}
        <select className="pickerHidden" {...api.getHiddenSelectProps()} />
      </div>
    </div>
  )
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

export function mountSummarizeControl(root: HTMLElement, props: SummarizeControlProps) {
  let current = props
  const renderPicker = () => {
    render(<SummarizeControl {...current} />, root)
  }

  renderPicker()

  return {
    update(next: SummarizeControlProps) {
      current = next
      renderPicker()
    },
  }
}
