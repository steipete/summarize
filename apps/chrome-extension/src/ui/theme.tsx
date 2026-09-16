import { message, type ExtensionMessageKey } from "../lib/i18n";
export function SchemeChips({ scheme }: { scheme: string }) {
  return (
    <span className={`scheme-chips scheme-${scheme}`} aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </span>
  );
}
import { colorSchemes, type ColorScheme } from "../lib/theme";

const schemeLabels: Record<ColorScheme, ExtensionMessageKey> = {
  slate: "slate",
  cedar: "cedar",
  mint: "mint",
  ocean: "ocean",
  ember: "ember",
  iris: "iris",
};
const themeItem = (value: ColorScheme) => ({ value, label: message(schemeLabels[value]) });
export const schemeItems = colorSchemes.map(themeItem);
export const modeItems = [
  { value: "system", label: message("system") },
  { value: "light", label: message("light") },
  { value: "dark", label: message("dark") },
];
