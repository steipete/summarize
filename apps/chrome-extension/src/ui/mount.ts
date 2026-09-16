import { createElement, render, type ComponentType } from "preact";
import { useLocale } from "./localized-text";

export function mountComponent<Props extends object>(
  root: HTMLElement,
  component: ComponentType<Props>,
  props: Props,
) {
  const LocalizedComponent = (next: Props) => {
    useLocale();
    return createElement(component, next);
  };
  const update = (next: Props) => render(createElement(LocalizedComponent, next), root);
  update(props);
  return { update };
}
