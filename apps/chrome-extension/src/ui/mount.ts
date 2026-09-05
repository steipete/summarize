import { createElement, render, type ComponentType } from "preact";

export function mountComponent<Props extends object>(
  root: HTMLElement,
  component: ComponentType<Props>,
  props: Props,
) {
  const update = (next: Props) => render(createElement(component, next), root);
  update(props);
  return { update };
}
