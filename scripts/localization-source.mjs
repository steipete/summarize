import { Window } from "happy-dom";
import { parseSync } from "oxc-parser";
import { LOCALIZED_ATTRIBUTES } from "../packages/core/src/localization/index.ts";

const displayProperties = new Set([
  "textContent",
  "innerText",
  "innerHTML",
  "title",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "label",
  "description",
  "tooltip",
]);
const domDisplayProperties = new Set([
  ...displayProperties,
  "value",
  "ariaLabel",
  "ariaDescription",
  "ariaValueText",
  "ariaPlaceholder",
  "ariaRoleDescription",
  "ariaBrailleLabel",
  "ariaBrailleRoleDescription",
]);
const displayCalls = new Set([
  "setStatus",
  "sendStatus",
  "pushStatus",
  "writeStatus",
  "headerSetStatus",
  "headerSetBaseTitle",
  "headerSetBaseSubtitle",
  "setBaseTitle",
  "setBaseSubtitle",
  "setMeta",
  "setDaemonStatus",
  "flashStatus",
  "setUiText",
  "setText",
  "showError",
  "setError",
  "showPanelError",
  "showInlineError",
  "alert",
  "confirm",
  "write",
  "setIndeterminate",
  "setPlaceholder",
]);
const technicalCalls = new Set([
  "querySelector",
  "querySelectorAll",
  "closest",
  "matches",
  "getElementById",
  "getAttribute",
  "removeAttribute",
]);
const technicalProperties = new Set([
  "className",
  "class",
  "id",
  "role",
  "fontFamily",
  "font",
  "selector",
  "rel",
  "d",
  "style",
  "cssText",
]);
const keyboardKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Escape",
  "Tab",
  "Home",
  "End",
  "Backspace",
  "Delete",
  "PageUp",
  "PageDown",
]);
function protocolComparison(node, parent, call, ancestors) {
  if (node.type !== "Literal" || typeof node.value !== "string") return false;
  let compared =
    parent?.type === "BinaryExpression"
      ? parent.left === node
        ? parent.right
        : parent.left
      : parent?.type === "SwitchCase"
        ? ancestors.findLast((ancestor) => ancestor.type === "SwitchStatement")?.discriminant
        : call?.callee?.object?.type === "ArrayExpression"
          ? call.arguments[0]
          : call?.callee?.object;
  while (
    compared &&
    ["ChainExpression", "TSAsExpression", "TSNonNullExpression"].includes(compared.type)
  )
    compared = compared.expression;
  const field =
    compared?.type === "MemberExpression"
      ? (compared.property?.name ?? compared.property?.value)
      : compared?.type === "Identifier"
        ? compared.name
        : null;
  // DOM key codes, exception names, and tagged protocol variants are identifiers, not labels.
  return (
    (["key", "code"].includes(field) && keyboardKeys.has(node.value)) ||
    (/name$/iu.test(field ?? "") && /^[A-Z]\w*(?:Error|Exception|Warning)$/u.test(node.value)) ||
    (["kind", "type"].includes(field) && /^[A-Z][A-Za-z0-9]+$/u.test(node.value))
  );
}
// Product names, font names, and compact format identifiers are intentionally invariant.
export const invariantLabels = new Set([
  "A",
  "XL",
  "XXL",
  "20k",
  "OCR",
  "PID",
  "CSS",
  "HTML",
  "JSON",
  "URL",
  "API",
  "UI",
  "LLM",
  "Chrome",
  "Firefox",
  "Safari",
  "OpenAI",
  "OpenRouter",
  "Anthropic",
  "Google Gemini",
  "Gemini Nano",
  "NVIDIA",
  "MiniMax",
  "Z.AI",
  "xAI",
  "Ollama",
  "Homebrew",
  "NPM",
  "npm",
  "Georgia",
  "Iowan",
  "Mono",
  "San Francisco",
  "Readability",
  "Firecrawl",
  "Apify",
  "Whisper",
  "Whisper.cpp",
  "Whisper/Groq",
  "Whisper/OpenAI",
  "Whisper/FAL",
  "AssemblyAI",
  "Gemini",
  "NVIDIA Parakeet",
  "NVIDIA Canary",
  "YouTube",
  "Nitter",
  "Xurl",
  "Bird",
]);

function prose(value) {
  return (
    /[\p{L}][\p{L}\p{M}]+\s+[\p{L}\d{(]/u.test(value) ||
    /^[A-Z][a-z]/u.test(value.trim()) ||
    /(?=[^\x00-\x7f])\p{L}/u.test(value)
  );
}
function regexProse(pattern) {
  const readable = pattern
    .replace(/\\[bBsSnrt]/gu, " ")
    .replace(/\(\?:/gu, "")
    .replace(/[()^$]/gu, "")
    .replace(/\s[*+?]+/gu, " ")
    .trim();
  return prose(readable) || /^[a-z]{3,}$/u.test(readable) || /\b[A-Z][a-z]{2,}/u.test(readable);
}
function technicalToken(value) {
  const text = value.trim();
  return (
    invariantLabels.has(text) ||
    [
      "GitHub Models",
      "GitHub Models API",
      "LaunchAgent",
      "systemd",
      "Scheduled Task",
      "Claude CLI",
      "Codex CLI",
      "Gemini CLI",
      "Cursor Agent CLI",
      "OpenClaw CLI",
      "OpenCode CLI",
      "GitHub Copilot CLI",
      "Antigravity CLI",
      "Pi CLI",
      "ONNX (Parakeet/Canary)",
      "yt-dlp",
    ].includes(text) ||
    /^(?:npm i -g|brew install)\s/u.test(text) ||
    /^\u001b(?:_G|\]1337;File=)/u.test(text) ||
    (text.includes("\u001b") && !/\p{L}/u.test(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""))) ||
    /^\d+[km]$/u.test(text) ||
    /^--[a-z][a-z-]*$/u.test(text) ||
    /^[\w.-]+\.(?:log|jsonl)$/u.test(text) ||
    /^[a-z]+(?:,[a-z]+)+$/u.test(text) ||
    /^#[0-9a-f]{3,8}$/iu.test(text) ||
    /^[a-z][\w./-]*:(?:[\w./:{}-])+$/u.test(text) ||
    /^(?:https?:\/\/|chrome:\/\/|moz-extension:\/\/|\.\.?\/)/u.test(text) ||
    (text.endsWith(" API") && invariantLabels.has(text.slice(0, -4)))
  );
}

/** Parse text nodes and visible attributes in static HTML and markup templates. */
export function inspectHtml(source) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  const root = window.document.createElement("template");
  root.innerHTML = source;
  const findings = [];
  const check = (value) => {
    const text = value.replaceAll("{}", "").trim();
    if (text && /\p{L}/u.test(text) && !technicalToken(text))
      findings.push({
        line: source.slice(0, Math.max(0, source.indexOf(value))).split("\n").length,
        text,
      });
  };
  const visit = (element, literalCode = false) => {
    for (const attribute of LOCALIZED_ATTRIBUTES) {
      if (
        attribute === "value" &&
        !(element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type))
      )
        continue;
      if (!element.hasAttribute(`data-i18n-${attribute}`) && element.hasAttribute(attribute))
        check(element.getAttribute(attribute));
    }
    if (["SCRIPT", "STYLE"].includes(element.tagName)) return;
    const code = literalCode || ["CODE", "PRE"].includes(element.tagName);
    if (!element.hasAttribute("data-i18n")) {
      if (!code || ["BUTTON", "OPTION", "TEXTAREA"].includes(element.tagName))
        for (const node of element.childNodes) if (node.nodeType === 3) check(node.textContent);
      for (const child of element.children) visit(child, code);
      if (element.tagName === "TEMPLATE") {
        for (const child of element.content.childNodes) {
          if (child.nodeType === 3 && !code) check(child.textContent);
          else if (child.nodeType === 1) visit(child, code);
        }
      }
    }
  };
  for (const child of root.content.childNodes) {
    if (child.nodeType === 3) check(child.textContent);
    else if (child.nodeType === 1) visit(child);
  }
  return findings;
}
function containsHtml(value) {
  return /<[a-z][\w:-]*(?:\s[^<>]*|\s*\/?)>/iu.test(value);
}
function expressionText(node) {
  if (!node) return "{}";
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral")
    return node.quasis.map((part) => part.value.cooked ?? part.value.raw).join("{}");
  if (node.type === "BinaryExpression" && node.operator === "+")
    return expressionText(node.left) + expressionText(node.right);
  return "{}";
}

/** Audit application copy, including constants and interpolated text. Exemptions name their purpose. */
export function inspectSource(file, source, { strict = true } = {}) {
  const parsed = parseSync(file, source);
  if (parsed.errors.length) return parsed.errors.map((error) => ({ line: 1, text: error.message }));
  const findings = [];
  const scopeTypes = new Set([
    "Program",
    "BlockStatement",
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  const bindings = new WeakMap();
  const memberWrites = [];
  const bind = (scope, name, value) => {
    if (!scope || !name) return;
    const entries = bindings.get(scope) ?? new Map();
    const sources = entries.get(name) ?? [];
    if (value) sources.push(value);
    entries.set(name, sources);
    bindings.set(scope, entries);
  };
  const bindPattern = (scope, pattern, value) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") bind(scope, pattern.name, value);
    else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((element, index) => {
        if (!element) return;
        bindPattern(
          scope,
          element.type === "RestElement" ? element.argument : element,
          value && {
            node: {
              type: "MemberExpression",
              object: value.node,
              property: { type: "Literal", value: String(index) },
              computed: true,
              arrayRest: element.type === "RestElement",
              start: pattern.start,
              end: pattern.end,
            },
            ancestors: value.ancestors,
          },
        );
      });
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        bindPattern(
          scope,
          property.value,
          value && {
            node: {
              type: "MemberExpression",
              object: value.node,
              property: property.key,
              computed: property.computed,
              start: pattern.start,
              end: pattern.end,
            },
            ancestors: value.ancestors,
          },
        );
      }
    } else if (pattern.type === "AssignmentPattern") {
      bindPattern(scope, pattern.left, value);
      bindPattern(scope, pattern.left, { node: pattern.right, ancestors: [scope, pattern] });
    }
  };
  const collectBindings = (node, ancestors = []) => {
    if (!node || typeof node !== "object") return;
    const scope = ancestors.findLast((ancestor) => scopeTypes.has(ancestor.type));
    if (node.type === "VariableDeclarator")
      bindPattern(
        scope,
        node.id,
        node.init && { node: node.init, ancestors: [...ancestors, node] },
      );
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      const owner =
        [...ancestors].reverse().find((ancestor) => bindings.get(ancestor)?.has(node.left.name)) ??
        scope;
      bind(owner, node.left.name, { node: node.right, ancestors: [...ancestors, node] });
    }
    if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression")
      memberWrites.push({ target: node.left, node: node.right, ancestors: [...ancestors, node] });
    if (/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(node.type))
      for (const parameter of node.params) bindPattern(node, parameter);
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => collectBindings(child, [...ancestors, node]));
      else if (value && typeof value === "object") collectBindings(value, [...ancestors, node]);
    }
  };
  collectBindings(parsed.program);
  const lineOf = (offset) => source.slice(0, offset).split("\n").length;
  const exemptions = parsed.comments.filter((comment) =>
    /i18n-ignore:\s*\S.{8,}/u.test(comment.value),
  );
  const ignored = (node, ancestors) => {
    const boundary = ancestors.findLastIndex((ancestor) =>
      /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(ancestor.type),
    );
    const scopes = ancestors
      .slice(boundary + 1)
      .filter((ancestor) =>
        [
          "ExpressionStatement",
          "VariableDeclaration",
          "ReturnStatement",
          "ThrowStatement",
          "Property",
          "CallExpression",
          "NewExpression",
          "TemplateLiteral",
        ].includes(ancestor.type),
      );
    return [node, ...scopes].some((scope) =>
      exemptions.some(
        (comment) =>
          comment.end <= scope.start && source.slice(comment.end, scope.start).trim() === "",
      ),
    );
  };
  const add = (node, text, ancestors) => {
    if (!text.trim() || !/\p{L}/u.test(text) || technicalToken(text) || ignored(node, ancestors))
      return;
    if (containsHtml(text) || text.includes("data-i18n")) {
      findings.push(
        ...inspectHtml(text).map((finding) => ({
          ...finding,
          line: lineOf(node.start) + finding.line - 1,
        })),
      );
      return;
    }
    findings.push({ line: lineOf(node.start), text });
  };
  // Follow local constants to presentation sinks; case alone cannot distinguish copy from protocol IDs.
  const resolveSources = (node, ancestors, seen = new Set()) => {
    if (!node || seen.has(node)) return [];
    const nextSeen = new Set([...seen, node]);
    if (node.type === "Identifier") {
      for (const scope of [...ancestors].reverse()) {
        const sources = bindings.get(scope)?.get(node.name);
        if (sources)
          return sources.flatMap((source) =>
            resolveSources(source.node, source.ancestors, nextSeen),
          );
      }
      return [];
    }
    if (["TSAsExpression", "TSNonNullExpression", "ChainExpression"].includes(node.type))
      return resolveSources(node.expression, [...ancestors, node], nextSeen);
    if (node.type === "MemberExpression") {
      const member = node.computed
        ? node.property.type === "Literal"
          ? String(node.property.value)
          : expressionText(node.property)
        : node.property.name;
      return resolveSources(node.object, [...ancestors, node], nextSeen).flatMap((source) => {
        const assigned = memberWrites.flatMap((write) => {
          if (nextSeen.has(write)) return [];
          const key = write.target.computed
            ? write.target.property.type === "Literal"
              ? String(write.target.property.value)
              : expressionText(write.target.property)
            : write.target.property.name;
          if (member !== "{}" && key !== "{}" && key !== member) return [];
          const writeSeen = new Set([...nextSeen, write]);
          const targets = resolveSources(write.target.object, write.ancestors, writeSeen);
          return targets.some((target) => target.node === source.node)
            ? resolveSources(write.node, write.ancestors, writeSeen)
            : [];
        });
        if (source.node.type === "ArrayExpression") {
          const elements = node.arrayRest
            ? source.node.elements.slice(Number(member))
            : member === "{}"
              ? source.node.elements
              : [source.node.elements[Number(member)]];
          if (node.arrayRest) return [{ ...source, node: { ...source.node, elements } }];
          return [
            ...assigned,
            ...elements.flatMap((element) =>
              resolveSources(element, [...source.ancestors, source.node], nextSeen),
            ),
          ];
        }
        if (source.node.type !== "ObjectExpression" || nextSeen.has(source.node)) return assigned;
        const propertySeen = new Set([...nextSeen, source.node]);
        return [
          ...assigned,
          ...source.node.properties.flatMap((property) => {
            if (property.type === "SpreadElement") {
              return resolveSources(
                { ...node, object: property.argument },
                [...source.ancestors, source.node, property],
                propertySeen,
              );
            }
            const key = property.computed
              ? expressionText(property.key)
              : (property.key.name ?? property.key.value);
            return member === "{}" || key === member
              ? resolveSources(
                  property.value,
                  [...source.ancestors, source.node, property],
                  propertySeen,
                )
              : [];
          }),
        ];
      });
    }
    return [{ node, ancestors }];
  };
  const traceCopy = (node, ancestors, accepts = () => true) => {
    const seen = new Set();
    const traceValue = (node, ancestors) => {
      if (!node || typeof node !== "object" || seen.has(node) || ignored(node, ancestors)) return;
      seen.add(node);
      if (node.type === "Identifier" || node.type === "MemberExpression") {
        const sources = resolveSources(node, ancestors);
        for (const source of sources) traceValue(source.node, source.ancestors);
        if (!sources.length && node.type === "MemberExpression")
          traceValue(node.object, [...ancestors, node]);
      } else if (node.type === "CallExpression" || node.type === "NewExpression") {
        const method =
          node.callee?.type === "MemberExpression"
            ? node.callee.computed
              ? expressionText(node.callee.property)
              : node.callee.property.name
            : node.callee?.name;
        if (method === "resolveText") {
          traceValue(node.arguments[0], [...ancestors, node]);
          return;
        }
        if (["createElement", "createElementNS"].includes(method)) return;
        if (
          [
            "t",
            "styled",
            "message",
            "uiMessage",
            "extensionMessage",
            "cliMessage",
            "sharedMessage",
            "readLocalizedMessage",
            "uiNumber",
            "uiDate",
            "uiRelativeTime",
            "useSelect",
            "buildExtractFinishLabel",
            "formatLengthTooltip",
          ].includes(method) ||
          technicalCalls.has(method) ||
          node.callee?.object?.name === "Intl" ||
          (node.callee?.type === "CallExpression" &&
            node.callee.callee?.name === "createCliTranslator")
        )
          return;
        if (node.callee?.type === "MemberExpression")
          traceValue(node.callee.object, [...ancestors, node]);
        for (const argument of node.arguments) traceValue(argument, [...ancestors, node]);
      } else if (node.type === "ArrayExpression") {
        for (const element of node.elements) traceValue(element, [...ancestors, node]);
      } else if (node.type === "ObjectExpression") {
        for (const property of node.properties) {
          traceValue(property.type === "SpreadElement" ? property.argument : property.value, [
            ...ancestors,
            node,
            property,
          ]);
        }
      } else if (node.type === "SpreadElement") {
        traceValue(node.argument, [...ancestors, node]);
      } else if (node.type === "Literal" && typeof node.value === "string") {
        if (accepts(node.value)) add(node, node.value, ancestors);
      } else if (node.type === "TemplateLiteral") {
        const text = expressionText(node);
        if (technicalToken(text)) return;
        if (accepts(text)) add(node, text, ancestors);
        for (const expression of node.expressions) traceValue(expression, [...ancestors, node]);
      } else if (node.type === "ConditionalExpression") {
        traceValue(node.consequent, [...ancestors, node]);
        traceValue(node.alternate, [...ancestors, node]);
      } else if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
        traceValue(node.left, [...ancestors, node]);
        traceValue(node.right, [...ancestors, node]);
      } else if (["TSAsExpression", "TSNonNullExpression"].includes(node.type)) {
        traceValue(node.expression, [...ancestors, node]);
      }
    };
    traceValue(node, ancestors);
  };
  const visit = (node, ancestors = []) => {
    if (!node || typeof node !== "object") return;
    const parent = ancestors.at(-1);
    const call = ancestors.findLast(
      (ancestor) => ancestor.type === "CallExpression" || ancestor.type === "NewExpression",
    );
    const callee = call?.callee;
    const method =
      callee?.type === "MemberExpression"
        ? callee.computed
          ? expressionText(callee.property)
          : callee.property.name
        : callee?.name;
    const receiver =
      callee?.type === "MemberExpression" && callee.object.type === "Identifier"
        ? callee.object.name
        : "";
    const assignment = ancestors.findLast((ancestor) => ancestor.type === "AssignmentExpression");
    const assignmentValue =
      assignment && (assignment.right === node || ancestors.includes(assignment.right));
    const assignedProperty =
      assignment?.left?.type === "MemberExpression"
        ? assignment.left.computed
          ? expressionText(assignment.left.property)
          : assignment.left.property.name
        : null;
    const jsxAttribute = ancestors.findLast((ancestor) => ancestor.type === "JSXAttribute")?.name
      ?.name;
    const property = parent?.type === "Property" ? (parent.key?.name ?? parent.key?.value) : null;
    const typeOnly = ancestors.some((ancestor) =>
      [
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "TSEnumDeclaration",
        "TSLiteralType",
        "ImportDeclaration",
      ].includes(ancestor.type),
    );
    const isKey = parent?.type === "Property" && parent.key === node;
    const comparison =
      (parent?.type === "BinaryExpression" &&
        ["===", "!==", "==", "!="].includes(parent.operator)) ||
      parent?.type === "SwitchCase";
    const textMatching =
      comparison ||
      [
        "includes",
        "startsWith",
        "endsWith",
        "split",
        "test",
        "match",
        "matchAll",
        "search",
        "replace",
        "replaceAll",
        "RegExp",
      ].includes(method);
    const diagnostic = ancestors.some(
      (ancestor) =>
        ancestor.type === "CallExpression" &&
        ([
          "writeVerbose",
          "writeVerboseLine",
          "logExtensionEvent",
          "logSlides",
          "logSlidesTiming",
          "writeDebug",
          "log",
        ].includes(ancestor.callee?.name) ||
          (ancestor.callee?.type === "MemberExpression" &&
            ancestor.callee.object?.name === "console")),
    );
    const callArgument = call?.arguments?.findIndex(
      (argument) => argument === node || ancestors.includes(argument),
    );
    const attributeNameValue =
      method === "setAttribute" ? expressionText(call.arguments[0]).toLowerCase() : null;
    const technicalAttribute =
      method === "setAttribute" && technicalProperties.has(attributeNameValue);
    const inHeaders =
      ancestors.some(
        (ancestor) =>
          ancestor.type === "Property" &&
          ["headers", "Authorization", "rootMargin"].includes(
            ancestor.key?.name ?? ancestor.key?.value,
          ),
      ) ||
      (method === "set" && call.arguments[0]?.value === "Authorization");
    const apiDiagnostic = call?.type === "NewExpression" && /Error$|Exception$/u.test(method ?? "");
    const technical =
      ancestors.some(
        (ancestor) =>
          ancestor.type === "TemplateLiteral" && technicalToken(expressionText(ancestor)),
      ) ||
      (method === "serviceCommandError" && call.arguments[0] === node) ||
      (textMatching && protocolComparison(node, parent, call, ancestors)) ||
      (["Option", "option", "argument", "helpOption"].includes(method) &&
        call.arguments[0] === node) ||
      technicalProperties.has(property) ||
      technicalProperties.has(assignedProperty) ||
      technicalProperties.has(jsxAttribute) ||
      technicalCalls.has(method) ||
      (method === "createElement" && callArgument === 0) ||
      (method === "createElementNS" && callArgument <= 1) ||
      technicalAttribute ||
      inHeaders ||
      (apiDiagnostic && !strict) ||
      receiver === "path" ||
      receiver === "process";
    const displayArgument =
      method === "sendStatus"
        ? callArgument === (call.arguments.length > 1 ? 1 : 0)
        : method === "setAttribute"
          ? callArgument === 1
          : ["setUiText", "setText", "setUiAttribute", "setLocalizedAttribute"].includes(method)
            ? callArgument > 0
            : callArgument === 0;
    const display =
      !textMatching &&
      ((!jsxAttribute && parent?.type === "JSXExpressionContainer") ||
        displayProperties.has(property) ||
        (assignmentValue && domDisplayProperties.has(assignedProperty)) ||
        displayProperties.has(jsxAttribute) ||
        LOCALIZED_ATTRIBUTES.includes(jsxAttribute) ||
        (method === "createElement" &&
          callArgument === 1 &&
          (LOCALIZED_ATTRIBUTES.includes(property) || property === "children")) ||
        (method === "createElement" && callArgument >= 2) ||
        (method === "setAttribute" &&
          displayArgument &&
          (LOCALIZED_ATTRIBUTES.includes(attributeNameValue) ||
            displayProperties.has(attributeNameValue))) ||
        (displayCalls.has(method) &&
          displayArgument &&
          (method !== "write" || callee.type === "MemberExpression")));
    if (!typeOnly && !isKey && !technical && !diagnostic) {
      const conditionalTest = ancestors.some(
        (ancestor, index) =>
          ancestor.type === "ConditionalExpression" &&
          (ancestor.test === node || ancestors.slice(index + 1).includes(ancestor.test)),
      );
      if (
        (display || textMatching) &&
        !conditionalTest &&
        [
          "Identifier",
          "MemberExpression",
          "CallExpression",
          "NewExpression",
          "ConditionalExpression",
          "LogicalExpression",
          "TemplateLiteral",
          "BinaryExpression",
        ].includes(node.type) &&
        !(parent?.type === "MemberExpression" && parent.property === node) &&
        !(parent?.type === "CallExpression" && parent.callee === node)
      )
        traceCopy(node, ancestors, display ? undefined : method === "RegExp" ? regexProse : prose);
      if (node.type === "Literal" && node.regex && regexProse(node.regex.pattern))
        add(node, node.regex.pattern, ancestors);
      if (node.type === "Literal" && typeof node.value === "string") {
        // Presentation errors must be keyed; native exception names are protocol identifiers.
        const apiDiagnostic =
          call?.type === "NewExpression" && /Error$|Exception$/u.test(method ?? "");
        const translationKey =
          ["CallExpression", "NewExpression"].includes(parent?.type) &&
          parent.arguments[0] === node &&
          ["message", "uiMessage", "extensionMessage", "t", "localize", "CliError"].includes(
            method,
          );
        const attributeName =
          ["setUiAttribute", "setLocalizedAttribute", "setAttribute"].includes(method) &&
          call?.arguments[method === "setAttribute" ? 0 : 1] === node;
        const headerName =
          node.value === "Authorization" && ["get", "set", "has", "delete"].includes(method);
        if (
          !translationKey &&
          !(apiDiagnostic && callArgument > 0) &&
          !attributeName &&
          !headerName &&
          (display ||
            ((strict || textMatching) &&
              (apiDiagnostic ||
                (method === "RegExp" ? regexProse(node.value) : prose(node.value)))) ||
            containsHtml(node.value))
        )
          add(node, node.value, ancestors);
        if (
          (method === "Option" || ["option", "argument"].includes(method)) &&
          call?.arguments[1] === node
        )
          add(node, node.value, ancestors);
        if (method === "description" && call?.arguments[0] === node)
          add(node, node.value, ancestors);
      }
      if (node.type === "JSXText") add(node, node.value.trim(), ancestors);
      if (
        node.type === "TemplateLiteral" ||
        (node.type === "BinaryExpression" && node.operator === "+")
      ) {
        const text = expressionText(node);
        if (display || ((strict || textMatching) && prose(text)) || containsHtml(text))
          add(node, text, ancestors);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, [...ancestors, node]));
      else if (value && typeof value === "object") visit(value, [...ancestors, node]);
    }
  };
  visit(parsed.program);
  return [
    ...new Map(findings.map((finding) => [`${finding.line}:${finding.text}`, finding])).values(),
  ];
}

const messageAttribute = new RegExp(`^data-i18n(?:-(?:${LOCALIZED_ATTRIBUTES.join("|")}))?$`, "iu");

function collectHtmlKeys(source, dynamic = false) {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true } });
  const template = window.document.createElement("template");
  template.innerHTML = source;
  const keys = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        if (messageAttribute.test(attribute.name) && !(dynamic && attribute.value.includes("{}")))
          keys.push(attribute.value);
      }
      if (element.tagName === "TEMPLATE") visit(element.content);
    }
  };
  visit(template.content);
  return keys;
}

/** Collect literal keys before looking them up, including unknown and wrong-surface keys. */
export function collectMessageKeys(file, source) {
  const keys = new Set();
  if (file.endsWith(".html")) {
    for (const key of collectHtmlKeys(source)) keys.add(key);
    return keys;
  }
  const visit = (node, ancestors = []) => {
    if (!node || typeof node !== "object") return;
    const staticString =
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateLiteral" && node.expressions.length === 0
          ? expressionText(node)
          : undefined;
    if (staticString !== undefined) {
      const call = ancestors.findLast((ancestor) =>
        ["CallExpression", "NewExpression"].includes(ancestor.type),
      );
      const method =
        call?.callee?.type === "MemberExpression"
          ? call.callee.computed
            ? expressionText(call.callee.property)
            : call.callee.property?.name
          : call?.callee?.name;
      const index = call?.arguments?.findIndex(
        (argument) => argument === node || ancestors.includes(argument),
      );
      const keyIndex = method === "emitCliMessage" ? 2 : method === "modelOption" ? 1 : 0;
      const keyedCall =
        [
          "t",
          "styled",
          "message",
          "uiMessage",
          "extensionMessage",
          "CliError",
          "cliMessage",
          "sharedMessage",
          "emitCliMessage",
          "modelOption",
          "statusMessage",
          "renderStatus",
          "renderStatusWithMeta",
          "renderMessage",
        ].includes(method) ||
        (call?.callee?.type === "CallExpression" &&
          call.callee.callee?.name === "createCliTranslator");
      const descriptorProperty = ancestors.findLast(
        (ancestor) =>
          ancestor.type === "Property" && (ancestor.key?.name ?? ancestor.key?.value) === "key",
      );
      const messageType =
        /\b(?:CliMessage|LocalizedMessage|SharedMessage|MessageDescriptor|MetricPart|FinishPart|FinishLabel)\b/u;
      const descriptor =
        descriptorProperty &&
        ancestors.some((ancestor) => {
          if (
            ancestor.type === "VariableDeclarator" &&
            ancestor.init &&
            node.start >= ancestor.init.start
          )
            return messageType.test(source.slice(ancestor.id.start, ancestor.id.end));
          const annotation =
            ancestor.returnType ??
            (["TSAsExpression", "TSSatisfiesExpression"].includes(ancestor.type)
              ? ancestor.typeAnnotation
              : null);
          return annotation && messageType.test(source.slice(annotation.start, annotation.end));
        });
      const parent = ancestors.at(-1);
      const isPropertyName = parent?.type === "Property" && parent.key === node;
      const typedMap = ancestors.some(
        (ancestor) =>
          ancestor.type === "VariableDeclarator" &&
          ancestor.init &&
          node.start >= ancestor.init.start &&
          /(?:Cli|Extension)MessageKey/u.test(source.slice(ancestor.id.start, ancestor.id.end)),
      );
      const jsxAttribute = ancestors.findLast((ancestor) => ancestor.type === "JSXAttribute");
      const jsxKey = messageAttribute.test(jsxAttribute?.name?.name ?? "");
      if (
        !isPropertyName &&
        ((keyedCall && index === keyIndex) || descriptor || typedMap || jsxKey)
      )
        keys.add(staticString);
      if (/data-i18n/iu.test(staticString))
        for (const key of collectHtmlKeys(staticString)) keys.add(key);
    }
    if (node.type === "TemplateLiteral" && /data-i18n/iu.test(expressionText(node))) {
      for (const key of collectHtmlKeys(expressionText(node), node.expressions.length > 0))
        keys.add(key);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, [...ancestors, node]));
      else if (value && typeof value === "object") visit(value, [...ancestors, node]);
    }
  };
  visit(parseSync(file, source).program);
  return keys;
}

export function inspectMessageUsage(file, source, sharedKeys, surfaceKeys) {
  const keys = collectMessageKeys(file, source);
  const unknown = [...keys].filter((key) => !sharedKeys.has(key) && !surfaceKeys.has(key));
  return { keys, unknown };
}
