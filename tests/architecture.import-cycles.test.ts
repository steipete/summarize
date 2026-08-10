import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSync, Visitor } from "oxc-parser";
import { describe, expect, it } from "vitest";

const sourceRoots = [
  resolve("src"),
  resolve("packages/core/src"),
  resolve("apps/chrome-extension/src"),
];

type SourceLayer = "cli" | "core" | "extension";

function sourceLayer(file: string): SourceLayer {
  if (file.startsWith(`${resolve("packages/core/src")}${sep}`)) return "core";
  if (file.startsWith(`${resolve("apps/chrome-extension/src")}${sep}`)) return "extension";
  return "cli";
}

type PackageExport = string | { import?: string };

type WorkspacePackage = {
  name: string;
  sourceRoot: string;
  exports: Record<string, PackageExport>;
};

function loadWorkspacePackage(packageDirectory: string, sourceRoot: string): WorkspacePackage {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    name: string;
    exports: Record<string, PackageExport>;
  };
  return {
    name: manifest.name,
    sourceRoot: resolve(sourceRoot),
    exports: manifest.exports,
  };
}

const workspacePackages = [
  loadWorkspacePackage(".", "src"),
  loadWorkspacePackage("packages/core", "packages/core/src"),
];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function moduleSpecifiers(file: string): string[] {
  const sourceText = readFileSync(file, "utf8");
  const parsed = parseSync(file, sourceText);
  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${displayPath(file)}:\n${parsed.errors
        .map((error) => error.codeframe ?? error.message)
        .join("\n")}`,
    );
  }
  const specifiers: string[] = [];

  new Visitor({
    ImportDeclaration(node) {
      specifiers.push(node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source) specifiers.push(node.source.value);
    },
    ExportAllDeclaration(node) {
      specifiers.push(node.source.value);
    },
    ImportExpression(node) {
      if (
        node.options === null &&
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        specifiers.push(node.source.value);
      }
    },
    TSImportType(node) {
      specifiers.push(node.source.value);
    },
  }).visit(parsed.program);
  return specifiers;
}

function resolveCandidate(unresolved: string, sourceFiles: ReadonlySet<string>): string | null {
  const withoutJsExtension = unresolved.replace(/\.(?:m|c)?js$/, "");
  const candidates = [
    unresolved,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    join(withoutJsExtension, "index.ts"),
    join(withoutJsExtension, "index.tsx"),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

function resolveWorkspaceImport(
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  for (const workspacePackage of workspacePackages) {
    if (specifier !== workspacePackage.name && !specifier.startsWith(`${workspacePackage.name}/`)) {
      continue;
    }
    const subpath =
      specifier === workspacePackage.name
        ? "."
        : `.${specifier.slice(workspacePackage.name.length)}`;
    const packageExport = workspacePackage.exports[subpath];
    const importTarget = typeof packageExport === "string" ? packageExport : packageExport?.import;
    if (!importTarget?.startsWith("./dist/esm/")) return null;
    const sourcePath = importTarget.slice("./dist/esm/".length);
    return resolveCandidate(resolve(workspacePackage.sourceRoot, sourcePath), sourceFiles);
  }
  return null;
}

function resolveSourceImport(
  importer: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | null {
  if (specifier.startsWith(".")) {
    return resolveCandidate(resolve(dirname(importer), specifier), sourceFiles);
  }
  return resolveWorkspaceImport(specifier, sourceFiles);
}

function buildImportGraph(files: readonly string[]): Map<string, string[]> {
  const sourceFiles = new Set(files);
  return new Map(
    files.map((file) => [
      file,
      moduleSpecifiers(file)
        .map((specifier) => resolveSourceImport(file, specifier, sourceFiles))
        .filter((dependency): dependency is string => dependency !== null),
    ]),
  );
}

function findImportCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(file: string): void {
    state.set(file, "visiting");
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        const cycleStart = stack.lastIndexOf(dependency);
        cycles.push([...stack.slice(cycleStart), dependency]);
      } else if (!dependencyState) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(file, "visited");
  }

  for (const file of graph.keys()) {
    if (!state.has(file)) visit(file);
  }
  return cycles;
}

function displayPath(file: string): string {
  return relative(process.cwd(), file).split(sep).join("/");
}

describe("production import graph", () => {
  it("has no import cycles", () => {
    const files = sourceRoots.flatMap(collectSourceFiles);
    const cycles = findImportCycles(buildImportGraph(files)).map((cycle) =>
      cycle.map(displayPath).join(" -> "),
    );

    expect(cycles).toEqual([]);
  });

  it("preserves the core-first workspace dependency direction", () => {
    const files = sourceRoots.flatMap(collectSourceFiles);
    const graph = buildImportGraph(files);
    const allowedDependencies: Record<SourceLayer, ReadonlySet<SourceLayer>> = {
      core: new Set(["core"]),
      cli: new Set(["cli", "core"]),
      extension: new Set(["extension", "core"]),
    };
    const violations: string[] = [];

    for (const [file, dependencies] of graph) {
      const layer = sourceLayer(file);
      for (const dependency of dependencies) {
        const dependencyLayer = sourceLayer(dependency);
        if (!allowedDependencies[layer].has(dependencyLayer)) {
          violations.push(
            `${displayPath(file)} (${layer}) -> ${displayPath(dependency)} (${dependencyLayer})`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("import graph parser", () => {
  it("preserves every module-reference form covered by the cycle gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "summarize-import-forms-"));
    const file = join(directory, "references.ts");
    try {
      writeFileSync(
        file,
        [
          'import "./side-effect.js";',
          'import type { StaticType } from "./static-type.js";',
          'export { value } from "./named-export.js";',
          'export * from "./star-export.js";',
          'const dynamic = import("./dynamic.js");',
          'type Imported = import("./type-import.js").Imported;',
          'const ignored = "./not-an-import.js";',
          'const ignoredOptions = import("./with-options.js", { with: { type: "json" } });',
        ].join("\n"),
      );

      expect(moduleSpecifiers(file)).toEqual([
        "./side-effect.js",
        "./static-type.js",
        "./named-export.js",
        "./star-export.js",
        "./dynamic.js",
        "./type-import.js",
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("detects a deliberately introduced TypeScript import cycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "summarize-import-cycle-"));
    const first = join(directory, "first.ts");
    const second = join(directory, "second.ts");
    try {
      writeFileSync(first, 'import "./second.js";\n');
      writeFileSync(second, 'export * from "./first.js";\n');

      const cycles = findImportCycles(buildImportGraph([first, second])).map((cycle) =>
        cycle.map((file) => relative(directory, file)),
      );

      expect(cycles).toEqual([["first.ts", "second.ts", "first.ts"]]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
