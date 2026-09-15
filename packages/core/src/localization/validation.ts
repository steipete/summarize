import { IntlMessageFormat } from "intl-messageformat";
import { isFallbackMessage } from "./index.js";

function messageSignature(message: string): string {
  const ast = new IntlMessageFormat(message, "en", undefined, { ignoreTag: true }).getAst();
  const argumentsByName = new Map<string, Set<string>>();
  const visit = (nodes: typeof ast) => {
    for (const node of nodes) {
      if (node.type === 0 || node.type === 7) continue;
      const types = argumentsByName.get(node.value) ?? new Set<string>();
      types.add(node.type === 6 ? `plural:${node.pluralType}` : String(node.type));
      argumentsByName.set(node.value, types);
      if (node.type === 5 || node.type === 6) {
        if (node.type === 5) types.add(`choices:${Object.keys(node.options).sort().join(",")}`);
        if (node.type === 6) {
          const exactChoices = Object.keys(node.options)
            .filter((choice) => choice.startsWith("="))
            .sort();
          types.add(
            `plural:${node.pluralType}:offset=${node.offset}:exact=${exactChoices.join(",")}`,
          );
        }
        for (const option of Object.values(node.options)) visit(option.value);
      }
    }
  };
  visit(ast);
  return JSON.stringify(
    [...argumentsByName]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, types]) => [name, [...types].sort()]),
  );
}

/** Checks the actual ICU AST, including arguments inside plural/select branches. */
export function validateCatalogs(
  base: Record<string, string>,
  catalogs: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const signatures = new Map<string, string>();
  for (const [key, value] of Object.entries(base)) {
    try {
      if (typeof value !== "string" || !value.trim())
        throw new Error("Expected a nonempty message");
      signatures.set(key, messageSignature(value));
    } catch (error) {
      errors.push(`en:${key}: ${String(error)}`);
    }
  }
  for (const [locale, catalog] of Object.entries(catalogs)) {
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      errors.push(`${locale}: Expected a message catalog`);
      continue;
    }
    const entries = catalog as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(entries, key)) errors.push(`${locale}:${key}: Missing key`);
    }
    for (const [key, value] of Object.entries(entries)) {
      if (!Object.hasOwn(base, key)) {
        errors.push(`${locale}:${key}: Stale key`);
        continue;
      }
      if (isFallbackMessage(value)) continue;
      try {
        if (typeof value !== "string" || !value.trim())
          throw new Error("Expected a nonempty message or a fallback with a reason");
        if (messageSignature(value) !== signatures.get(key))
          errors.push(`${locale}:${key}: Placeholder mismatch`);
      } catch (error) {
        errors.push(`${locale}:${key}: ${String(error)}`);
      }
    }
  }
  return errors;
}
