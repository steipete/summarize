import path from "node:path";
import { css, js, preThemeScript, themeToggleHtml } from "./docs-site-assets.mjs";
import { escapeAttr, escapeHtml } from "./docs-site-markdown.mjs";

export const repoBase = "https://github.com/steipete/summarize";
const repoEditBase = `${repoBase}/edit/main/docs`;
export const productName = "summarize";
const productTagline = "Link → clean text → sharp summary.";
export const productDescription =
  "summarize is a fast CLI and Chrome Side Panel for clean extraction and sharp summaries — web pages, PDFs, images, audio, video, YouTube, and podcasts. Local, paid, and free models all work.";
export const installLine = "npm i -g @steipete/summarize";
const heroModes = [
  ["Website", "lime"],
  ["YouTube", "orange"],
  ["Podcasts", "teal"],
  ["PDF", "lime"],
  ["Audio", "orange"],
  ["Video", "teal"],
  ["Slides", "lime"],
];

function normalizePermalink(value) {
  let v = value.trim();
  if (!v) return "/";
  if (!v.startsWith("/")) v = `/${v}`;
  if (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  return v;
}

export function hrefToOutRel(targetOutRel, currentOutRel) {
  const currentDir = path.posix.dirname(currentOutRel);
  if (targetOutRel.endsWith("/index.html")) {
    const targetDir = targetOutRel.slice(0, -"index.html".length);
    const rel = path.posix.relative(currentDir, targetDir || ".") || ".";
    return rel.endsWith("/") ? rel : `${rel}/`;
  }
  if (targetOutRel === "index.html") {
    const rel = path.posix.relative(currentDir, ".") || ".";
    return rel.endsWith("/") ? rel : `${rel}/`;
  }
  return path.posix.relative(currentDir, targetOutRel) || path.posix.basename(targetOutRel);
}

export function createDocsLayout({ pageMap, nav, siteBase }) {
  return layout;

  function isHomePage(page) {
    if (page.frontmatter.permalink && normalizePermalink(page.frontmatter.permalink) === "/") {
      return true;
    }
    return page.rel === "index.md" || page.rel === "README.md";
  }

  function homeHero(page) {
    const description = page.frontmatter.description || productDescription;
    const tagline = page.frontmatter.tagline || productTagline;
    const installRel = pageMap.get("install.md")
      ? hrefToOutRel(pageMap.get("install.md").outRel, page.outRel)
      : "install.html";
    const quickstartRel = pageMap.get("quickstart.md")
      ? hrefToOutRel(pageMap.get("quickstart.md").outRel, page.outRel)
      : "quickstart.html";
    return `<header class="home-hero">
        <p class="eyebrow">CLI · Chrome Side Panel</p>
        <h1>${escapeHtml(tagline)}</h1>
        <p class="lede">${escapeHtml(description)}</p>
        <div class="home-cta">
          <a class="btn btn-primary" href="${quickstartRel}">Quickstart</a>
          <a class="btn btn-ghost" href="${repoBase}" rel="noopener">GitHub</a>
          <div class="home-install" aria-label="Install with npm">
            <span class="prompt" aria-hidden="true">$</span>
            <code>${escapeHtml(installLine)}</code>
          </div>
        </div>
        <div class="home-modes" aria-label="Supported sources">
          ${heroModes.map(([label, color]) => `<span class="m-${color}">${escapeHtml(label)}</span>`).join("")}
        </div>
        <p class="muted"><a href="${installRel}">Other install options →</a></p>
      </header>`;
  }

  function standardHero(page, sectionName, editUrl) {
    return `<header class="hero">
        <div class="hero-text">
          <p class="eyebrow">${escapeHtml(sectionName)}</p>
          <h1>${escapeHtml(page.title)}</h1>
        </div>
        <div class="hero-meta">
          <a class="repo" href="${repoBase}" rel="noopener">GitHub</a>
          <a class="edit" href="${escapeAttr(editUrl)}" rel="noopener">Edit page</a>
        </div>
      </header>`;
  }

  function layout({ page, html, toc, prev, next, sectionName }) {
    const depth = page.outRel.split("/").length - 1;
    const rootPrefix = depth ? "../".repeat(depth) : "";
    const editUrl = `${repoEditBase}/${page.rel}`;
    const home = isHomePage(page);
    const prevNext = !home && (prev || next) ? pageNavHtml(prev, next, page.outRel) : "";
    const heroBlock = home ? homeHero(page) : standardHero(page, sectionName, editUrl);
    const articleClass = home ? "doc doc-home" : "doc";
    const tocBlock = home ? "" : toc;
    const titleSuffix = home
      ? `${productName} — ${productTagline}`
      : `${page.title} — ${productName}`;
    const description =
      page.frontmatter.summary ||
      page.frontmatter.description ||
      (home ? productDescription : `${page.title} — ${productName} CLI documentation.`);
    const canonicalUrl = pageCanonicalUrl(page);
    const socialImage = siteBase ? `${siteBase}/social-card.png` : `${rootPrefix}social-card.png`;
    const socialMeta = [
      ["link", "rel", "canonical", "href", canonicalUrl],
      ["meta", "property", "og:type", "content", "website"],
      ["meta", "property", "og:site_name", "content", productName],
      ["meta", "property", "og:title", "content", titleSuffix],
      ["meta", "property", "og:description", "content", description],
      ["meta", "property", "og:url", "content", canonicalUrl],
      ["meta", "property", "og:image", "content", socialImage],
      ["meta", "name", "twitter:card", "content", "summary_large_image"],
      ["meta", "name", "twitter:title", "content", titleSuffix],
      ["meta", "name", "twitter:description", "content", description],
      ["meta", "name", "twitter:image", "content", socialImage],
      ["meta", "name", "theme-color", "content", "#0b0f12"],
    ]
      .map(tagHtml)
      .join("\n  ");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(titleSuffix)}</title>
  <meta name="description" content="${escapeAttr(description)}">
  ${socialMeta}
  <link rel="icon" href="${rootPrefix}favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <script>${preThemeScript()}</script>
  <style>${css()}</style>
</head>
<body${home ? ' class="home"' : ""}>
  <button class="nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false">
    <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>
  </button>
  <div class="shell">
    <aside class="sidebar">
      <div class="sidebar-head">
        <a class="brand" href="${hrefToOutRel("index.html", page.outRel)}" aria-label="${productName} docs home">
          <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <span><strong>${escapeHtml(productName)}</strong><small>CLI &amp; Side Panel docs</small></span>
        </a>
        ${themeToggleHtml()}
      </div>
      <label class="search"><span>Search</span><input id="doc-search" type="search" placeholder="youtube, daemon, slides"></label>
      <nav>${navHtml(page)}</nav>
    </aside>
    <main>
      ${heroBlock}
      <div class="doc-grid${home ? " doc-grid-home" : ""}">
        <article class="${articleClass}">${html}${prevNext}</article>
        ${tocBlock}
      </div>
    </main>
  </div>
  <script>${js()}</script>
</body>
</html>`;
  }

  function pageCanonicalUrl(page) {
    if (!siteBase) return page.outRel;
    if (page.outRel === "index.html") return `${siteBase}/`;
    const rel = page.outRel.endsWith("/index.html")
      ? page.outRel.slice(0, -"index.html".length)
      : page.outRel;
    return `${siteBase}/${rel}`;
  }

  function tagHtml([tag, k1, v1, k2, v2]) {
    return tag === "link"
      ? `<link ${k1}="${v1}" ${k2}="${escapeAttr(v2)}">`
      : `<meta ${k1}="${v1}" ${k2}="${escapeAttr(v2)}">`;
  }

  function pageNavHtml(prev, next, currentOutRel) {
    const cell = (page, dir) => {
      if (!page) return "";
      return `<a class="page-nav-${dir}" href="${hrefToOutRel(page.outRel, currentOutRel)}"><small>${dir === "prev" ? "Previous" : "Next"}</small><span>${escapeHtml(page.title)}</span></a>`;
    };
    return `<nav class="page-nav" aria-label="Pager">${cell(prev, "prev")}${cell(next, "next")}</nav>`;
  }

  function navHtml(currentPage) {
    return nav
      .map(
        (section) =>
          `<section><h2>${escapeHtml(section.name)}</h2>${section.pages
            .map((page) => {
              const href = hrefToOutRel(page.outRel, currentPage.outRel);
              const active = page.rel === currentPage.rel ? " active" : "";
              return `<a class="nav-link${active}" href="${href}">${escapeHtml(navTitle(page))}</a>`;
            })
            .join("")}</section>`,
      )
      .join("");
  }

  function navTitle(page) {
    if (page.rel === "index.md") return "Overview";
    if (page.rel === "commands/index.md") return "Commands";
    return page.title.replace(/^`summarize\s*/, "").replace(/`$/, "");
  }
}
