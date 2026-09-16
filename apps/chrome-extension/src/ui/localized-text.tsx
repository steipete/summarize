import { useEffect, useState } from "preact/hooks";
import {
  getActiveExtensionLocale,
  resolveText,
  subscribeLocale,
  type LocalizedText,
} from "../lib/i18n";

export function useLocale() {
  const [locale, setLocale] = useState(getActiveExtensionLocale);
  useEffect(() => {
    const refresh = () => setLocale(getActiveExtensionLocale());
    const stop = subscribeLocale(refresh);
    refresh();
    return stop;
  }, []);
  return locale;
}

export function MessageText({ value }: { value: LocalizedText }) {
  useLocale();
  return <>{resolveText(value)}</>;
}
