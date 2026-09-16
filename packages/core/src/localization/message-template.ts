import { IntlMessageFormat } from "intl-messageformat";

type Elements = ReturnType<IntlMessageFormat["getAst"]>;
type Tag = Extract<Elements[number], { type: 8 }>;
export type MessageStyle = "uiLabel" | "uiDetail" | "uiValue";
export type MessageStyles = Partial<Record<MessageStyle | "default", (text: string) => string>>;
const cache = new Map<string, { ast: Elements; styled: boolean }>();

/** Reserve only presentation tags; CLI syntax such as <input> remains literal text. */
export function parseMessageTemplate(template: string): { ast: Elements; styled: boolean } {
  const cached = cache.get(template);
  if (cached) return cached;
  let styled = false;
  const transform = (nodes: Elements): Elements => {
    const result: Elements = [];
    const stack: Tag[] = [];
    const append = (node: Elements[number]) => (stack.at(-1)?.children ?? result).push(node);
    for (const original of nodes) {
      if (original.type === 0) {
        const parts = original.value.split(/(<\/?(?:uiLabel|uiDetail|uiValue)>)/u);
        for (const part of parts) {
          if (!part) continue;
          const marker = part.match(/^<(\/?)(uiLabel|uiDetail|uiValue)>$/u);
          if (!marker) {
            append({ type: 0, value: part });
            continue;
          }
          styled = true;
          if (marker[1]) {
            if (stack.at(-1)?.value !== marker[2]) throw new Error("Unbalanced message style tags");
            stack.pop();
          } else {
            const tag: Tag = { type: 8, value: marker[2], children: [] };
            append(tag);
            stack.push(tag);
          }
        }
      } else if (original.type === 5 || original.type === 6) {
        append({
          ...original,
          options: Object.fromEntries(
            Object.entries(original.options).map(([key, option]) => [
              key,
              { ...option, value: transform(option.value) },
            ]),
          ),
        });
      } else append(original);
    }
    if (stack.length) throw new Error("Unclosed message style tag");
    return result;
  };
  const ast = transform(
    new IntlMessageFormat(template, "en", undefined, { ignoreTag: true }).getAst(),
  );
  const parsed = { ast, styled };
  cache.set(template, parsed);
  return parsed;
}
