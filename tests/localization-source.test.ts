import { describe, expect, it } from "vitest";
import {
  collectMessageKeys,
  inspectHtml,
  inspectSource,
  inspectMessageUsage,
} from "../scripts/localization-source.mjs";

describe("localization source enforcement", () => {
  it.each([
    'const label = "loading"; setStatus(label);',
    'const first = "loading"; const next = first; node.textContent = next;',
    'let label; label = "loading"; setStatus(label);',
    'const label = ready ? "ready" : "loading"; setStatus(label);',
    "const label = `loading`; const view = <button>{label}</button>;",
    'const view = <span>{busy ? "loading" : "ready"}</span>;',
    'const view = <span>{busy && "loading"}</span>;',
    'const view = <span>{value || "loading"}</span>;',
    'const labels = { status: "loading" }; setStatus(labels.status);',
    'const labels = { nested: { status: "loading" } }; setStatus(labels.nested.status);',
    'const labels = { status: "loading" }; const {status: label} = labels; setStatus(label);',
    'const labels = { status: "loading" }; setStatus(labels["status"]);',
    'const [label] = ["loading"]; setStatus(label);',
    'const labels = ["loading"]; const [label] = labels; setStatus(label);',
    'const [[label]] = [["loading"]]; setStatus(label);',
    'const [{status: label}] = [{status: "loading"}]; setStatus(label);',
    'const [label = "loading"] = []; setStatus(label);',
    'const [, ...labels] = ["id", "loading"]; setStatus(labels[0]);',
    'const view = <button aria-roledescription="loading" />;',
    'const view = createElement("button", null, "loading");',
    'const view = createElement("button", { title: "loading" });',
    'const view = createElement("button", { "aria-roledescription": "loading" });',
    'const view = createElement("button", { children: "loading" });',
    'setStatus(format({ text: "loading" }));',
    'const details = { text: "loading" }; setStatus(format({ ...details }));',
    'const state = {}; state.status = "loading"; setStatus(state.status);',
    'const state = {}; const alias = state; alias.status = "loading"; setStatus(state.status);',
    'const state = {nested:{}}; state.nested.status = "loading"; setStatus(state.nested.status);',
    'const state = []; state[0] = "loading"; setStatus(state[0]);',
    'const state = {}; state["status"] = "loading"; setStatus(state.status);',
  ])("follows lowercase copy into display sinks: %s", (source) => {
    expect(inspectSource("fixture.tsx", source).map((item) => item.text)).toContain("loading");
  });
  it("checks controls and attributes nested inside code while exempting literal code text", () => {
    expect(inspectHtml("<pre><code><span>example code</span></code></pre>")).toEqual([]);
    expect(
      inspectHtml('<pre><code><button title="Retry">Try again</button></code></pre>').map(
        (item) => item.text,
      ),
    ).toEqual(["Retry", "Try again"]);
    expect(
      inspectHtml('<code><span aria-label="Example"></span></code>').map((item) => item.text),
    ).toEqual(["Example"]);
  });
  it("audits factory children and accessibility props without treating DOM tags as copy", () => {
    expect(
      inspectSource(
        "fixture.ts",
        'document.createElement("button"); document.createElementNS("http://www.w3.org/2000/svg", "svg");',
      ),
    ).toEqual([]);
    expect(
      inspectSource("fixture.ts", 'createElement("button", { title: "Retry" }, "Try again")').map(
        (item) => item.text,
      ),
    ).toEqual(["Retry", "Try again"]);
    for (const attribute of [
      "aria-roledescription",
      "aria-placeholder",
      "aria-braillelabel",
      "aria-brailleroledescription",
    ]) {
      expect(inspectSource("fixture.tsx", `<button ${attribute}="loading" />`)).toHaveLength(1);
    }
  });
  it("respects lexical shadowing and bounded protocol annotations during copy tracing", () => {
    expect(
      inspectSource(
        "fixture.ts",
        'const label = "loading"; function render(label: string) { setStatus(label); }',
      ),
    ).toEqual([]);
    expect(
      inspectSource(
        "fixture.ts",
        '// i18n-ignore: External provider result code.\nconst label = "loading"; setStatus(label);',
      ),
    ).toEqual([]);
  });
  it.each([
    "/Loading page/.test(status);",
    "status.match(/Try again/);",
    'status.replace(/^Warning:/, "");',
    "const pattern = /Loading page/; status.match(pattern);",
    "/^Loading$/.exec(status);",
    "/loading\\s+page/i.test(status);",
    'new RegExp("Loading page").test(status);',
    'new RegExp("^Loading\\\\s+page$").test(status);',
    "status.matchAll(/Loading page/g);",
    "/^loading$/.test(status);",
  ])("audits regex-based English matching: %s", (source) => {
    expect(inspectSource("fixture.ts", source, { strict: false }).length).toBeGreaterThan(0);
  });
  it("permits numeric regexes and explicitly annotated external protocol patterns", () => {
    expect(
      inspectSource(
        "fixture.ts",
        "const pattern = /^\\s*(?:[-*•]|\\d+[.)])\\s+/; pattern.test(text);",
        { strict: false },
      ),
    ).toEqual([]);
    expect(
      inspectSource(
        "fixture.ts",
        "// i18n-ignore: HTTP authentication scheme.\nconst pattern = /^Bearer\\s+(.+)$/;",
      ),
    ).toEqual([]);
    expect(
      inspectSource("fixture.ts", 'db.exec("CREATE TABLE data (id INTEGER)");', { strict: false }),
    ).toEqual([]);
  });
  it.each([
    'status.startsWith("Loading");',
    'text.split("Warning:");',
    'status === "Try again";',
    'switch (status) { case "Loading": break; }',
    '["Loading"].includes(status);',
    'text.replaceAll("Loading", "Ready");',
    'const needle = "Loading page"; status.startsWith(needle);',
    'const needle = "Loading"; const alias = needle; text.includes(alias);',
    'const pattern = "Loading page"; new RegExp(pattern).test(status);',
    'const pattern = "loading"; new RegExp(pattern).test(status);',
  ])("rejects English text matching even outside a strict UI module: %s", (source) => {
    expect(inspectSource("fixture.ts", source, { strict: false }).length).toBeGreaterThan(0);
  });
  it("recognizes specific protocol identifiers and bounded API-diagnostic annotations", () => {
    expect(
      inspectSource(
        "fixture.ts",
        'event.key === "ArrowDown"; ["Home", "End"].includes(event.key); error.name === "AbortError"; (error as Error)?.name === "QuotaExceededError"; item.kind === "Listing";',
      ),
    ).toEqual([]);
    expect(
      inspectSource(
        "fixture.ts",
        'message.includes(/* i18n-ignore: Native fetch API diagnostic. */ "failed to fetch");',
      ),
    ).toEqual([]);
    expect(collectMessageKeys("data.ts", 'render("ordinary document content");')).toEqual(
      new Set(),
    );
  });
  it.each([
    ["fixture.ts", 't("progress.typo");'],
    ["fixture.ts", 'new CliError("progress.typo");'],
    ["fixture.ts", 'cliMessage("progress.typo");'],
    ["fixture.ts", 'sharedMessage("progress.typo");'],
    ["fixture.ts", 'renderMessage("progress.typo");'],
    ["fixture.ts", 'const event: CliMessage = { key: "progress.typo" as const, values: {} };'],
    [
      "fixture.ts",
      'const labels: Record<"title", ExtensionMessageKey> = { "title": "progress.typo" };',
    ],
    ["fixture.tsx", '<button data-i18n={"progress.typo"} />;'],
    ["fixture.tsx", "<button data-i18n={`progress.typo`} />;"],
    ["fixture.ts", "t(`progress.typo`);"],
    ["fixture.ts", "const html = '<button DATA-I18N=\"progress.typo\"></button>';"],
    ["fixture.ts", 'const html = `<button DATA-I18N="progress.typo">${content}</button>`;'],
    [
      "fixture.html",
      '<template><template><button data-i18n="progress.typo"></button></template></template>',
    ],
    ["fixture.html", "<button data-i18n = progress.typo></button>"],
    ["fixture.ts", 'const html = `<button data-i18n = "progress.typo"></button>`;'],
    ["fixture.ts", 'const html = `<img data-i18n-alt="progress.typo">`;'],
    ["fixture.ts", 'const html = "<custom-element data-i18n=progress.typo></custom-element>";'],
  ])("reports a genuinely unknown key in %s: %s", (file, source) => {
    expect(inspectMessageUsage(file, source, new Set(), new Set()).unknown).toEqual([
      "progress.typo",
    ]);
  });
  it("does not treat ordinary key/values data as a localization descriptor", () => {
    expect(
      collectMessageKeys(
        "data.ts",
        'const row = { key: "cache-entry", values: [1, 2] }; const other = { key: "ready", values: {} };',
      ),
    ).toEqual(new Set());
  });
  it.each([
    'function render() { element.textContent = "New copy"; }',
    'if (active) { element.textContent = "New copy"; }',
    'const handler = () => { element.textContent = "New copy"; };',
    'const config = { callback: () => { element.textContent = "New copy"; } };',
  ])("does not extend an annotation into a function or control-flow block: %s", (source) => {
    expect(
      inspectSource("fixture.ts", "// i18n-ignore: One protocol literal only.\n" + source).map(
        (finding) => finding.text,
      ),
    ).toContain("New copy");
  });
  it("rejects keys that exist only on the other surface", () => {
    const shared = new Set(["progress.shared"]);
    const cli = new Set(["help.command"]);
    const extension = new Set(["action.retry"]);
    expect(
      inspectMessageUsage(
        "panel.html",
        '<button data-i18n="help.command"></button>',
        shared,
        extension,
      ).unknown,
    ).toEqual(["help.command"]);
    expect(inspectMessageUsage("cli.ts", 't("action.retry");', shared, cli).unknown).toEqual([
      "action.retry",
    ]);
    expect(
      inspectMessageUsage(
        "panel.html",
        '<button data-i18n="progress.shared"></button>',
        shared,
        extension,
      ).unknown,
    ).toEqual([]);
  });
  it.each([
    'button.textContent = "Try again";',
    'button.title = "Retry";',
    'element["textContent"] = "loading";',
    'element[`title`] = "loading";',
    'setStatus(format("loading"));',
    'setStatus("loading".toUpperCase());',
    'node.textContent = decorate("loading");',
    'button["setAttribute"](`aria-label`, "loading");',
    'button.setAttribute("ARIA-LABEL", "loading");',
    'input.value = "retry";',
    'button.ariaLabel = "close";',
    'button.ariaRoleDescription = "action";',
    'setStatus(resolveText("loading"));',
    'setStatus("summarize this page");',
    'stdout.write("\\u001b[31mLoading\\u001b[0m");',
    'button.setAttribute("aria-label", "retry");',
    'button.setAttribute("title", "loading");',
    'const label = "loading"; button.setAttribute("title", label);',
    'const html = "<li>Retry</li>";',
    'const html = "<custom-control>loading</custom-control>";',
    "setStatus(`Loaded ${count} pages`);",
    'const label = "Save changes";',
    'const view = <button aria-label="Close">Retry</button>;',
    'program.option("--quiet", "Hide progress");',
    'throw new Error("Missing token");',
    "container.innerHTML = `<button>Retry</button>`;",
  ])("rejects uncatalogued copy: %s", (source) => {
    expect(inspectSource("fixture.tsx", source).length).toBeGreaterThan(0);
  });

  it("accepts keyed copy, data, identifiers, and narrowly explained protocol exemptions", () => {
    const source = `
      setText(button, message("action.retry"));
      node.textContent = page.title;
      node.className = "loading compact";
      node.setAttribute("role", "button");
      fetch(url, { headers: { Authorization: token } });
      // i18n-ignore: Instructions for the summary model, independent of UI language.
      const prompt = "Summarize this article";
    `;
    expect(inspectSource("fixture.ts", source)).toEqual([]);
    expect(inspectSource("fixture.ts", '// i18n-ignore:\nconst label = "New copy";')).toHaveLength(
      1,
    );
  });

  it("checks static HTML text, placeholders, and markup templates", () => {
    expect(
      inspectHtml(
        '<code title="Copy command">raw code</code><pre aria-label="Generated output">raw output</pre>',
      ).map((item) => item.text),
    ).toEqual(["Copy command", "Generated output"]);
    expect(inspectHtml("<button>summarize this page</button>")).toHaveLength(1);
    expect(inspectHtml('<button aria-roledescription="action"></button>')).toHaveLength(1);
    expect(
      inspectHtml("<button>Summarize</button><option>auto</option>").map((item) => item.text),
    ).toEqual(["Summarize", "auto"]);
    expect(inspectSource("fixture.ts", 'button.textContent = "Summarize";')).toHaveLength(1);
    expect(
      inspectHtml('<a data-i18n="brand.name"></a><button data-i18n="summarize"></button>'),
    ).toEqual([]);
    expect(
      inspectHtml("<template><template><button>loading</button></template></template>").map(
        (item) => item.text,
      ),
    ).toEqual(["loading"]);
    expect(
      inspectHtml(
        '<input type="button" value="Save"><input type="submit" value="Send"><input type="reset" value="Clear"><select><optgroup label="Choices"><option label="English label"></option></optgroup></select>',
      ).map((item) => item.text),
    ).toEqual(["Save", "Send", "Clear", "Choices", "English label"]);
    expect(
      inspectHtml(
        '<input type="hidden" value="protocol data"><input type="button" data-i18n-value="action.save"><option data-i18n-label="label.option"></option>',
      ),
    ).toEqual([]);
    expect([
      ...collectMessageKeys(
        "fixture.html",
        '<input type="button" data-i18n-value="action.save"><option data-i18n-label="label.option"></option>',
      ),
    ]).toEqual(["action.save", "label.option"]);
    expect(
      inspectHtml('Untranslated <span data-i18n="known"></span>').map((item) => item.text),
    ).toEqual(["Untranslated"]);
    expect(
      inspectSource(
        "fixture.ts",
        'const html = `<custom-control data-i18n="known"></custom-control>`;',
      ),
    ).toEqual([]);
    expect(
      inspectHtml(
        '<main><button data-i18n="action.retry"></button><input data-i18n-placeholder="input.prompt"><code>summarize --help</code></main>',
      ),
    ).toEqual([]);
    expect(
      inspectHtml(
        '<main><button title="Retry">Try again</button><input placeholder="Search"></main>',
      ).map((item) => item.text),
    ).toEqual(["Retry", "Try again", "Search"]);
    expect(
      inspectSource("fixture.ts", 'const html = `<button title="Retry">${name}</button>`;'),
    ).toHaveLength(1);
  });

  it("terminates on cyclic spread assignments while retaining reachable copy", () => {
    expect(
      inspectSource(
        "fixture.ts",
        'let labels = { status: "loading" }; labels = { ...labels }; setStatus(labels.status);',
      ).map((item) => item.text),
    ).toContain("loading");
    expect(inspectSource("fixture.ts", 'setStatus(resolveText(message("action.retry")));')).toEqual(
      [],
    );
  });

  it("counts actual key references rather than coincidental protocol values or tests", () => {
    const source = `
      const internalState = "ready";
      setText(button, message("action.retry"));
      const event: CliMessage = { key: "progress.slides" as const, values: { percent: 0.5 } };
      const labels: Record<string, ExtensionMessageKey> = { title: "label.title" };
    `;
    expect([...collectMessageKeys("fixture.ts", source)]).toEqual([
      "action.retry",
      "progress.slides",
      "label.title",
    ]);
    expect([
      ...collectMessageKeys("fixture.html", '<button data-i18n="missing.key"></button>'),
    ]).toEqual(["missing.key"]);
  });
});
