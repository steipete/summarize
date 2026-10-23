type DrawerRuntimeOpts = {
  drawerEl: HTMLElement;
  drawerToggleBtn: HTMLButtonElement;
  advancedSettingsEl: HTMLDetailsElement;
  advancedSettingsBodyEl: HTMLElement;
  refreshModelsIfStale: () => void;
};

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

type CollapseAnimationBox = { current: Animation | null };

const clearCollapseStyles = (el: HTMLElement) => {
  for (const property of ["height", "opacity", "transform", "overflow"] as const) {
    el.style.removeProperty(property);
  }
};

type CollapseCallbacks = {
  fill?: FillMode;
  stylesBeforeOpen?: boolean;
  prepareOpen: () => void;
  settle: (next: boolean) => void;
  onOpenedFinished?: () => void;
  onClosedFinished?: () => void;
};

const runCollapse = (
  box: CollapseAnimationBox,
  el: HTMLElement,
  next: boolean,
  animate: boolean,
  callbacks: CollapseCallbacks,
) => {
  box.current?.cancel();
  box.current = null;
  clearCollapseStyles(el);
  if (!animate) {
    callbacks.settle(next);
    return;
  }
  const applyStartStyles = (height: number) => {
    el.style.height = next ? "0px" : `${height}px`;
    el.style.opacity = next ? "0" : "1";
    el.style.transform = next ? "translateY(-6px)" : "translateY(0px)";
    el.style.overflow = "hidden";
  };
  const stylesFirst = next && callbacks.stylesBeforeOpen === true;
  if (stylesFirst) applyStartStyles(0);
  if (next) callbacks.prepareOpen();

  const targetHeight = next ? el.scrollHeight : el.getBoundingClientRect().height;
  if (!stylesFirst) applyStartStyles(targetHeight);

  const keyframes: Keyframe[] = next
    ? [
        { height: "0px", opacity: 0, transform: "translateY(-6px)" },
        { height: `${targetHeight}px`, opacity: 1, transform: "translateY(0px)" },
      ]
    : [
        { height: `${targetHeight}px`, opacity: 1, transform: "translateY(0px)" },
        { height: "0px", opacity: 0, transform: "translateY(-6px)" },
      ];
  const timing: KeyframeAnimationOptions = next
    ? { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }
    : { duration: 180, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
  if (callbacks.fill) timing.fill = callbacks.fill;

  const animation = el.animate(keyframes, timing);
  animation.onfinish = () => {
    box.current = null;
    if (next) {
      clearCollapseStyles(el);
      callbacks.onOpenedFinished?.();
    } else {
      callbacks.onClosedFinished?.();
      clearCollapseStyles(el);
    }
  };
  animation.oncancel = () => {
    box.current = null;
  };
  box.current = animation;
};

export function createDrawerControls(opts: DrawerRuntimeOpts) {
  const drawerAnimation: CollapseAnimationBox = { current: null };
  const advancedSettingsAnimation: CollapseAnimationBox = { current: null };

  function toggleDrawer(force?: boolean, animationOpts?: { animate?: boolean }) {
    const reducedMotion = prefersReducedMotion();
    const animate = animationOpts?.animate !== false && !reducedMotion;
    const isOpen = !opts.drawerEl.classList.contains("hidden");
    const next = typeof force === "boolean" ? force : !isOpen;

    opts.drawerToggleBtn.classList.toggle("isActive", next);
    opts.drawerToggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
    opts.drawerEl.setAttribute("aria-hidden", next ? "false" : "true");

    if (next === isOpen) return;

    runCollapse(drawerAnimation, opts.drawerEl, next, animate, {
      prepareOpen: () => opts.drawerEl.classList.remove("hidden"),
      settle: (value) => opts.drawerEl.classList.toggle("hidden", !value),
      onClosedFinished: () => opts.drawerEl.classList.add("hidden"),
    });
  }

  function toggleAdvancedSettings(force?: boolean, animationOpts?: { animate?: boolean }) {
    const reducedMotion = prefersReducedMotion();
    const animate = animationOpts?.animate !== false && !reducedMotion;
    const isOpen = opts.advancedSettingsEl.open;
    const next = typeof force === "boolean" ? force : !isOpen;

    if (next === isOpen) {
      if (next) opts.refreshModelsIfStale();
      return;
    }

    runCollapse(advancedSettingsAnimation, opts.advancedSettingsBodyEl, next, animate, {
      fill: "both",
      stylesBeforeOpen: true,
      prepareOpen: () => {
        opts.advancedSettingsEl.open = true;
      },
      settle: (value) => {
        opts.advancedSettingsEl.open = value;
        if (value) opts.refreshModelsIfStale();
      },
      onOpenedFinished: () => opts.refreshModelsIfStale(),
      onClosedFinished: () => {
        opts.advancedSettingsEl.open = false;
      },
    });
  }

  return {
    hasAdvancedSettingsAnimation: () => Boolean(advancedSettingsAnimation.current),
    toggleAdvancedSettings,
    toggleDrawer,
  };
}
