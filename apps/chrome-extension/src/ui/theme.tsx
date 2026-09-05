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
import { colorModes, colorSchemes } from "../lib/theme";

const themeItem = (value: string) => ({ value, label: value[0].toUpperCase() + value.slice(1) });
export const schemeItems = colorSchemes.map(themeItem);
export const modeItems = colorModes.map(themeItem);
