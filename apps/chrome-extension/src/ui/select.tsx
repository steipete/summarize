import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

const OPEN_EVENT = "summarize:select-open";
const VIEWPORT_GUTTER = 8;
const POPOVER_GUTTER = 6;

export type SelectItem = {
  label: string;
  value: string;
  disabled?: boolean;
};

type UseSelectArgs = {
  id: string;
  items: SelectItem[];
  value: string;
  onValueChange: (value: string) => void;
};

export function useSelect({ id, items, value, onValueChange }: UseSelectArgs) {
  const [open, setOpenState] = useState(false);
  const [selectedValue, setSelectedValue] = useState(value);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [positionerStyle, setPositionerStyle] = useState<JSX.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const positionerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const typeaheadRef = useRef({ query: "", updatedAt: 0 });

  const selectedIndex = items.findIndex((item) => item.value === selectedValue);
  const valueAsString = useMemo(
    () => items.find((item) => item.value === selectedValue)?.label ?? "",
    [items, selectedValue],
  );

  useEffect(() => {
    setSelectedValue(value);
  }, [value]);

  const firstEnabledIndex = useCallback(
    (direction: 1 | -1, start: number) => {
      if (items.length === 0) return -1;
      for (let offset = 0; offset < items.length; offset += 1) {
        const index = (start + offset * direction + items.length) % items.length;
        if (!items[index]?.disabled) return index;
      }
      return -1;
    },
    [items],
  );

  const focusItem = useCallback((index: number) => {
    if (index < 0) return;
    setHighlightedIndex(index);
    requestAnimationFrame(() => itemRefs.current[index]?.focus());
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_GUTTER * 2);
    const width = Math.min(rect.width, availableWidth);
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, rect.left),
      Math.max(VIEWPORT_GUTTER, window.innerWidth - VIEWPORT_GUTTER - width),
    );
    let top = rect.bottom + POPOVER_GUTTER;
    const popoverHeight = positionerRef.current?.getBoundingClientRect().height ?? 0;
    if (
      popoverHeight > 0 &&
      top + popoverHeight > window.innerHeight - VIEWPORT_GUTTER &&
      rect.top - POPOVER_GUTTER - popoverHeight >= VIEWPORT_GUTTER
    ) {
      top = rect.top - POPOVER_GUTTER - popoverHeight;
    }
    setPositionerStyle({
      left,
      top,
      width,
      maxWidth: availableWidth,
      "--reference-width": `${rect.width}px`,
      "--available-width": `${availableWidth}px`,
    } as JSX.CSSProperties);
  }, []);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (!next) return;
      const initial = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(1, 0);
      setHighlightedIndex(initial);
      requestAnimationFrame(updatePosition);
    },
    [firstEnabledIndex, selectedIndex, updatePosition],
  );

  const moveHighlight = useCallback(
    (direction: 1 | -1) => {
      const start =
        highlightedIndex >= 0
          ? highlightedIndex + direction
          : direction === 1
            ? 0
            : items.length - 1;
      focusItem(firstEnabledIndex(direction, start));
    },
    [firstEnabledIndex, focusItem, highlightedIndex, items.length],
  );

  const focusByTypeahead = useCallback(
    (key: string) => {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query =
        now - previous.updatedAt > 500
          ? key.toLowerCase()
          : `${previous.query}${key.toLowerCase()}`;
      typeaheadRef.current = { query, updatedAt: now };
      const start = highlightedIndex >= 0 ? highlightedIndex + 1 : 0;
      for (let offset = 0; offset < items.length; offset += 1) {
        const index = (start + offset) % items.length;
        const item = items[index];
        if (!item?.disabled && item.label.toLowerCase().startsWith(query)) {
          if (!open) setOpen(true);
          focusItem(index);
          return;
        }
      }
    },
    [focusItem, highlightedIndex, items, open, setOpen],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      if (!detail || detail.id === id) return;
      setOpenState(false);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, [id]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { id } }));
    updatePosition();
    requestAnimationFrame(updatePosition);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || positionerRef.current?.contains(target)) return;
      setOpenState(false);
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [id, open, updatePosition]);

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        requestAnimationFrame(() => {
          const initial =
            selectedIndex >= 0
              ? selectedIndex
              : firstEnabledIndex(
                  event.key === "ArrowDown" ? 1 : -1,
                  event.key === "ArrowDown" ? 0 : items.length - 1,
                );
          focusItem(initial);
        });
      } else {
        moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(!open);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      focusByTypeahead(event.key);
    }
  };

  const onItemKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      focusItem(firstEnabledIndex(direction, event.key === "Home" ? 0 : items.length - 1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      focusByTypeahead(event.key);
    }
  };

  return {
    value: selectedValue ? [selectedValue] : [],
    valueAsString,
    open,
    setOpen,
    getRootProps: () => ({
      id: `${id}-root`,
      "data-state": open ? "open" : "closed",
    }),
    getLabelProps: () => ({
      htmlFor: `${id}-trigger`,
    }),
    getTriggerProps: () => ({
      id: `${id}-trigger`,
      type: "button" as const,
      role: "combobox" as const,
      "aria-controls": `${id}-listbox`,
      "aria-expanded": open,
      "aria-haspopup": "listbox" as const,
      "data-state": open ? "open" : "closed",
      ref: (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
      },
      onClick: (_event: MouseEvent) => setOpen(!open),
      onPointerDown: (_event: PointerEvent) => undefined,
      onKeyDown: onTriggerKeyDown,
    }),
    getPositionerProps: () => ({
      ref: (node: HTMLDivElement | null) => {
        positionerRef.current = node;
      },
      style: positionerStyle,
    }),
    getContentProps: () => ({
      hidden: !open,
      "data-state": open ? "open" : "closed",
    }),
    getListProps: () => ({
      id: `${id}-listbox`,
      role: "listbox" as const,
      "aria-labelledby": `${id}-trigger`,
    }),
    getItemProps: ({ item }: { item: SelectItem }) => {
      const index = items.indexOf(item);
      const selected = item.value === selectedValue;
      return {
        id: `${id}-option-${index}`,
        type: "button" as const,
        role: "option" as const,
        "aria-selected": selected,
        disabled: item.disabled,
        tabIndex: highlightedIndex === index ? 0 : -1,
        "data-state": selected ? "checked" : "unchecked",
        "data-highlighted": highlightedIndex === index ? "" : undefined,
        ref: (node: HTMLButtonElement | null) => {
          itemRefs.current[index] = node;
        },
        onFocus: () => setHighlightedIndex(index),
        onPointerMove: () => {
          if (!item.disabled) setHighlightedIndex(index);
        },
        onKeyDown: onItemKeyDown,
        onClick: () => {
          if (item.disabled) return;
          if (item.value !== selectedValue) {
            setSelectedValue(item.value);
            onValueChange(item.value);
          }
          setOpen(false);
          triggerRef.current?.focus();
        },
      };
    },
  };
}
