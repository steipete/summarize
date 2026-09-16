import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTranslator,
  messageParameters,
  localeDirection,
  negotiateLocale,
} from "../packages/core/src/localization/index.js";
import { validateCatalogs } from "../packages/core/src/localization/validation.js";

const base = {
  count: "{count, plural, one {# summary} other {# summaries}}",
  user: "{name}: {mode, select, ready {Ready} other {Waiting}}",
};

describe("shared localization runtime", () => {
  it("negotiates only catalogs actually registered by a surface", () => {
    expect(negotiateLocale("de", ["tr-TR"], ["en", "tr"])).toBe("tr");
    expect(negotiateLocale("auto", ["de-DE"], ["en", "tr"])).toBe("en");
  });
  it("styles complete ICU messages without interpreting interpolated data or CLI placeholders", () => {
    const styled = {
      value:
        "<uiLabel>{count, plural, one {# file} other {# files}}</uiLabel><uiDetail>: {path}; use <input></uiDetail>",
    };
    const t = createTranslator(styled, {}, "en", {
      uiLabel: (text) => `[${text}]`,
      uiDetail: (text) => `(${text})`,
    });
    expect(t("value", { count: 2, path: "<uiLabel>Try again</uiLabel>" })).toBe(
      "[2 files](: <uiLabel>Try again</uiLabel>; use <input>)",
    );
    expect([...messageParameters(styled.value).keys()]).toEqual(["count", "path"]);
    expect(
      validateCatalogs(styled, {
        tr: {
          value:
            "<uiLabel>{count, plural, other {# dosya}}</uiLabel><uiDetail>: {path}; <input> kullanın</uiDetail>",
        },
      }),
    ).toEqual([]);
    expect(
      validateCatalogs(styled, {
        tr: { value: "<uiLabel>{count, plural, other {# dosya}}</uiDetail>: {path}" },
      })[0],
    ).toContain("Unbalanced");
    expect(() => createTranslator({ bad: "<uiLabel>Unclosed" }, {}, "en")("bad")).toThrow(
      "Unclosed",
    );
    expect(
      validateCatalogs(styled, {
        tr: {
          value:
            "<uiLabel>{count, plural, other {# dosya}}</uiLabel><uiDetail>{missing}</uiDetail>",
        },
      }),
    ).toContain("tr:value: Placeholder mismatch");
  });
  it.each([
    ["de-AT", [], "de"],
    ["pt", [], "pt-BR"],
    ["pt-PT", [], "pt-BR"],
    ["zh-TW", [], "zh-Hant"],
    ["zh-HK", [], "zh-Hant"],
    ["zh-CN", [], "zh-Hans"],
    ["zh-Hans-TW", [], "zh-Hans"],
    ["auto", ["unsupported", "ja-JP"], "ja"],
    ["en", ["tr-TR"], "en"],
    ["tr_TR.UTF-8", [], "tr"],
    ["C.UTF-8", ["de"], "en"],
    ["unknown", ["fr-FR"], "fr"],
    ["auto", [], "en"],
  ])("negotiates %s with %j", (setting, preferences, expected) => {
    expect(negotiateLocale(setting as string, preferences as string[])).toBe(expected);
  });

  it("supports ICU plural, select, nested arguments, and literal braces", () => {
    const t = createTranslator(
      base,
      {
        de: {
          count: "{count, plural, one {# Zusammenfassung} other {# Zusammenfassungen}}",
          user: "{name}: {mode, select, ready {Bereit} other {Warten}}",
        },
      },
      "de",
    );
    expect(t("count", { count: 1 })).toBe("1 Zusammenfassung");
    expect(t("count", { count: 1200 })).toBe("1.200 Zusammenfassungen");
    expect(t("user", { name: "<script>Try again</script>", mode: "ready" })).toBe(
      "<script>Try again</script>: Bereit",
    );
    const escaped = createTranslator({ command: "Use '{input}' and ''quoted''" }, {}, "en");
    expect(escaped("command")).toBe("Use {input} and 'quoted'");
    expect(() => t("count")).toThrow();
  });

  it("uses English grammar for explicit and missing fallbacks", () => {
    const t = createTranslator(
      base,
      { ja: { count: { fallback: "en", reason: "Reviewed migration" } } },
      "ja",
    );
    expect(t("count", { count: 1 })).toBe("1 summary");
    expect(t("user", { name: "A", mode: "ready" })).toBe("A: Ready");
    expect(localeDirection("de")).toBe("ltr");
    expect(localeDirection("ar")).toBe("rtl");
  });

  it("accepts JSON-shaped markers and rejects invalid fallback declarations at load time", () => {
    const imported = { count: { fallback: "en", reason: "Reviewed fixture" } };
    expect(createTranslator(base, { de: imported }, "de")("count", { count: 1 })).toBe("1 summary");
    expect(() =>
      createTranslator(
        base,
        { de: { count: { fallback: "fr", reason: "Wrong base" } } },
        "de",
      )("count", { count: 1 }),
    ).toThrow("Invalid English fallback marker");
    expect(() =>
      createTranslator(
        base,
        { de: { count: { fallback: "en", reason: "" } } },
        "de",
      )("count", { count: 1 }),
    ).toThrow("Invalid English fallback marker");
  });

  it("typechecks a reviewed fallback marker imported from JSON", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "summarize-fallback-type-"));
    try {
      writeFileSync(
        path.join(directory, "catalog.json"),
        JSON.stringify({ count: { fallback: "en", reason: "Reviewed fixture" } }),
      );
      const source = path
        .resolve("packages/core/src/localization/index.js")
        .replaceAll(path.sep, "/");
      const entry = path.join(directory, "consumer.mts");
      writeFileSync(
        entry,
        `import raw from "./catalog.json" with { type: "json" };\nimport type { Catalog } from ${JSON.stringify(source)};\nconst catalog: Catalog = raw;\nvoid catalog;\n`,
      );
      expect(() =>
        execFileSync(
          process.execPath,
          [
            path.resolve("node_modules/typescript/bin/tsc"),
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--module",
            "NodeNext",
            "--target",
            "ES2022",
            "--resolveJsonModule",
            entry,
          ],
          { encoding: "utf8" },
        ),
      ).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing, stale, empty, malformed, and mismatched messages", () => {
    expect(validateCatalogs(base, { de: { ...base } })).toEqual([]);
    expect(validateCatalogs(base, { de: { count: base.count, stale: "Old" } })).toEqual([
      "de:user: Missing key",
      "de:stale: Stale key",
    ]);
    expect(validateCatalogs(base, { de: { ...base, count: "{total, number}" } })).toContain(
      "de:count: Placeholder mismatch",
    );
    expect(validateCatalogs(base, { de: { ...base, count: "{" } })[0]).toContain("de:count:");
    expect(
      validateCatalogs(base, { de: { ...base, count: { fallback: "en", reason: "" } } })[0],
    ).toContain("nonempty");
    expect(
      validateCatalogs(base, {
        de: { ...base, user: "{name}: {mode, select, ready {{unexpected}} other {Waiting}}" },
      }),
    ).toContain("de:user: Placeholder mismatch");
  });

  it("preserves exact plural cases and offsets but allows local plural categories", () => {
    const english = {
      count: "{n, plural, offset:1 =0 {No guests} one {One other guest} other {# other guests}}",
    };
    expect(
      validateCatalogs(english, {
        de: {
          count:
            "{n, plural, offset:1 =0 {Keine Gäste} one {Ein weiterer Gast} few {# weitere Gäste} other {# weitere Gäste}}",
        },
      }),
    ).toEqual([]);
    expect(
      validateCatalogs(english, {
        de: {
          count:
            "{n, plural, offset:2 =0 {Keine Gäste} one {Ein weiterer Gast} other {# weitere Gäste}}",
        },
      }),
    ).toContain("de:count: Placeholder mismatch");
    expect(
      validateCatalogs(english, {
        de: { count: "{n, plural, offset:1 one {Ein weiterer Gast} other {# weitere Gäste}}" },
      }),
    ).toContain("de:count: Placeholder mismatch");
  });

  it("fails the CI command on a deliberately broken catalog", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "summarize-catalog-"));
    try {
      writeFileSync(path.join(directory, "en.json"), JSON.stringify(base));
      writeFileSync(path.join(directory, "de.json"), JSON.stringify(base));
      const args = [
        "--import",
        "./scripts/register-typescript.mjs",
        "scripts/check-localization.mjs",
        directory,
      ];
      expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toContain("complete");
      writeFileSync(path.join(directory, "de.json"), JSON.stringify({ count: base.count }));
      const broken = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain("de:user: Missing key");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
