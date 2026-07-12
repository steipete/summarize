export const optionsTabs = [
  "general",
  "ui",
  "runtime",
  "model",
  "skills",
  "advanced",
  "processes",
  "logs",
] as const;

export type OptionsTab = (typeof optionsTabs)[number];

export function isOptionsTab(value: unknown): value is OptionsTab {
  return typeof value === "string" && optionsTabs.includes(value as OptionsTab);
}
