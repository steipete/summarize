#!/usr/bin/env node
// Build the summarize docs site from `docs/*.md` into `dist/docs-site/`.
// Single-pass static generator: walks markdown files, applies a sidebar
// layout, inlines CSS/JS, validates internal links, copies static assets.
import fs from "node:fs";
import path from "node:path";
import { faviconSvg } from "./docs-site-assets.mjs";
import {
  createDocsLayout,
  hrefToOutRel,
  productName,
  productDescription,
  installLine,
  repoBase,
} from "./docs-site-layout.mjs";
import { renderMarkdown, tocFromHtml } from "./docs-site-markdown.mjs";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const outDir = path.join(root, "dist", "docs-site");
const cname = readCname();
const siteBase = cname ? `https://${cname}` : "";

const sections = [
  ["Start", ["index.md", "install.md", "quickstart.md", "config.md"]],
  [
    "Modes",
    [
      "website.md",
      "youtube.md",
      "media.md",
      "extract-only.md",
      "slides.md",
      "timestamps.md",
      "language.md",
    ],
  ],
  [
    "Models",
    [
      "llm.md",
      "cli.md",
      "openai.md",
      "model-auto.md",
      "model-provider-resolution.md",
      "firecrawl.md",
    ],
  ],
  ["Apps", ["chrome-extension.md", "agent.md"]],
  [
    "Internals",
    [
      "cache.md",
      "transcript-provider-flow.md",
      "nvidia-onnx-transcription.md",
      "slides-rendering-flow.md",
    ],
  ],
  ["Reference", ["commands/index.md", "releasing.md", "manual-tests.md", "smoketest.md"]],
];

// docs/README.md is the GitHub-facing index, and docs/refactor/* are scratch.
// commands/{summarize,slides,...}.md are deep-linked from the Reference index
// but we don't crowd the sidebar with them.
const buildExcludes = [/^README\.md$/, /^refactor\//];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const allPages = allMarkdown(docsDir).map((file) => {
  const rel = path.relative(docsDir, file).replaceAll(path.sep, "/");
  const raw = fs.readFileSync(file, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const cleaned = stripStrayDirectives(body);
  const title = frontmatter.title || firstHeading(cleaned) || titleize(path.basename(rel, ".md"));
  return { file, rel, title, outRel: outPath(rel), markdown: cleaned, frontmatter };
});

const pages = allPages.filter((page) => !buildExcludes.some((re) => re.test(page.rel)));
const pageMap = new Map(pages.map((page) => [page.rel, page]));

const nav = sections
  .map(([name, rels]) => ({
    name,
    pages: rels.map((rel) => pageMap.get(rel)).filter(Boolean),
  }))
  .filter((section) => section.pages.length);

const sectionByRel = new Map();
for (const section of nav)
  for (const page of section.pages) sectionByRel.set(page.rel, section.name);
const orderedPages = nav.flatMap((s) => s.pages);

const layout = createDocsLayout({ pageMap, nav, siteBase });

for (const page of pages) {
  const html = renderMarkdown(page.markdown, page.rel, {
    rewriteHref: (href, currentRel) => rewriteHref(href, currentRel),
  });
  const toc = tocFromHtml(html);
  const idx = orderedPages.findIndex((p) => p.rel === page.rel);
  const prev = idx > 0 ? orderedPages[idx - 1] : null;
  const next = idx >= 0 && idx < orderedPages.length - 1 ? orderedPages[idx + 1] : null;
  const sectionName = sectionByRel.get(page.rel) || "Reference";
  const pageOut = path.join(outDir, page.outRel);
  fs.mkdirSync(path.dirname(pageOut), { recursive: true });
  fs.writeFileSync(pageOut, layout({ page, html, toc, prev, next, sectionName }), "utf8");
}

fs.writeFileSync(path.join(outDir, "favicon.svg"), faviconSvg(), "utf8");
copyAssetsDir();
fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");
if (cname) fs.writeFileSync(path.join(outDir, "CNAME"), cname, "utf8");
validateLinks(outDir);
fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt(), "utf8");
console.log(`built docs site: ${path.relative(root, outDir)}`);

function llmsTxt() {
  const origin = siteBase.replace(/\/$/, "");
  const source = repoBase;
  const name = productName;
  const description = productDescription;
  const install = installLine;
  const docPages = docsLlmsPages().map(
    (page) => `- ${page.title}: ${pageUrl(origin, page.outRel)}`,
  );
  const lines = [`# ${name}`, "", description, "", "Canonical documentation:", ...docPages];
  if (install) {
    lines.push("", "Install:", `- ${install}`);
  }
  if (source) {
    lines.push("", `Source: ${source}`);
  }
  lines.push(
    "",
    "Guidance for agents:",
    "- Prefer the canonical documentation URLs above over README excerpts or package metadata.",
    "- Fetch only the pages needed for the current task; this is an index, not a full-site corpus.",
  );
  return `${lines.join("\n")}\n`;
}

function docsLlmsPages() {
  const seen = new Set();
  return [...orderedPages, ...pages].filter(
    (page) => page.outRel && !seen.has(page.outRel) && seen.add(page.outRel),
  );
}

function pageUrl(origin, outRel) {
  const normalized =
    outRel === "index.html"
      ? ""
      : outRel.replace(/(?:^|\/)index\.html$/, (match) => (match === "index.html" ? "" : "/"));
  if (!origin) return normalized || "index.html";
  return normalized ? `${origin}/${normalized}` : `${origin}/`;
}

function readCname() {
  for (const candidate of [path.join(docsDir, "CNAME"), path.join(root, "CNAME")]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8").trim();
  }
  return "summarize.sh";
}

function copyAssetsDir() {
  const src = path.join(docsDir, "assets");
  if (!fs.existsSync(src)) return;
  const dest = path.join(outDir, "assets");
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/\.(css|js)$/i.test(entry.name)) continue;
    fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return { frontmatter: fm, body: raw.slice(match[0].length) };
}

function stripStrayDirectives(body) {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*\{:\s*[^}]*\}\s*$/.test(line))
    .map((line) => line.replace(/\s*\{:\s*[^}]*\}\s*$/, ""))
    .join("\n");
}

function allMarkdown(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return allMarkdown(full);
      return entry.name.endsWith(".md") ? [full] : [];
    })
    .sort();
}

function outPath(rel) {
  // Home is at /, all other pages under /docs/ — preserves existing
  // summarize.sh URLs (and matches the historical Jekyll permalink scheme).
  if (rel === "index.md") return "index.html";
  if (rel === "README.md") return "index.html";
  if (rel.endsWith("/README.md")) return `docs/${rel.replace(/README\.md$/, "index.html")}`;
  if (rel.endsWith("/index.md")) return `docs/${rel.replace(/index\.md$/, "index.html")}`;
  return `docs/${rel.replace(/\.md$/, ".html")}`;
}

function firstHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function titleize(input) {
  return input.replaceAll("-", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function rewriteHref(href, currentRel) {
  if (/^(https?:|mailto:|tel:|#)/.test(href)) return href;
  const [raw, hash = ""] = href.split("#");
  if (!raw) return hash ? `#${hash}` : "";
  const currentOut = pageMap.get(currentRel)?.outRel || outPath(currentRel);
  // Map historical absolute /docs/<page>.html links (and bare /docs/foo) to
  // the corresponding markdown source so the output references stay correct.
  const absMatch = absoluteToMarkdown(raw);
  if (absMatch) {
    const target = pageMap.get(absMatch);
    if (target) {
      const out = hrefToOutRel(target.outRel, currentOut);
      return hash ? `${out}#${hash}` : out;
    }
  }
  // Same-tree relative .md links — including hash fragments — stay portable.
  // Relative .html links from the legacy Jekyll structure (e.g. `docs/install.html`
  // inside index.md) get redirected to the matching markdown source.
  if (raw.endsWith(".md")) {
    const from = path.posix.dirname(currentRel);
    const target = path.posix.normalize(path.posix.join(from, raw));
    const rewritten = hrefToOutRel(pageMap.get(target)?.outRel || outPath(target), currentOut);
    return `${rewritten}${hash ? `#${hash}` : ""}`;
  }
  if (raw.endsWith(".html")) {
    const from = path.posix.dirname(currentRel);
    const guess = path.posix
      .normalize(path.posix.join(from, raw))
      .replace(/\.html$/, ".md")
      .replace(/^docs\//, "");
    const candidate = pageMap.get(guess);
    if (candidate) {
      const rewritten = hrefToOutRel(candidate.outRel, currentOut);
      return `${rewritten}${hash ? `#${hash}` : ""}`;
    }
  }
  return href;
}

function absoluteToMarkdown(raw) {
  if (!raw.startsWith("/")) return null;
  if (raw === "/") return "index.md";
  let trimmed = raw.replace(/^\/docs\//, "").replace(/^\//, "");
  if (trimmed === "" || trimmed.endsWith("/")) {
    return `${trimmed}index.md`.replace(/^\.?\//, "");
  }
  if (trimmed.endsWith(".html")) trimmed = trimmed.replace(/\.html$/, ".md");
  if (!trimmed.endsWith(".md")) trimmed = `${trimmed}.md`;
  return trimmed;
}

function validateLinks(outputDir) {
  const failures = [];
  const placeholderHrefs = /^(url|path|file|dir|name)$/i;
  for (const file of allHtml(outputDir)) {
    const html = fs.readFileSync(file, "utf8");
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (/^(#|https?:|mailto:|tel:|javascript:)/.test(href)) continue;
      if (placeholderHrefs.test(href)) continue;
      const [rawPath, anchor = ""] = href.split("#");
      const targetPath = rawPath ? path.resolve(path.dirname(file), rawPath) : file;
      const target =
        fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
          ? path.join(targetPath, "index.html")
          : targetPath;
      if (!fs.existsSync(target)) {
        failures.push(
          `${path.relative(outputDir, file)}: ${href} -> missing ${path.relative(outputDir, target)}`,
        );
        continue;
      }
      if (anchor) {
        const targetHtml = fs.readFileSync(target, "utf8");
        if (!targetHtml.includes(`id="${anchor}"`) && !targetHtml.includes(`name="${anchor}"`)) {
          failures.push(`${path.relative(outputDir, file)}: ${href} -> missing anchor`);
        }
      }
    }
  }
  if (failures.length) {
    throw new Error(`broken docs links:\n${failures.join("\n")}`);
  }
}

function allHtml(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return allHtml(full);
      return entry.name.endsWith(".html") ? [full] : [];
    })
    .sort();
}
