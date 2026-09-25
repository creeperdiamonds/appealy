// web/docs-renderer/render.mjs
//
// Turns the docs branch into the static site at docs.appealy.app.
//
//   node render.mjs <docs-content-dir> <output-dir>
//
// The documentation lives on its own branch as plain Markdown — README.md,
// SUMMARY.md and a folder per section, nothing else — so it can be read on
// GitHub, edited without touching the app, and reviewed on its own. This file
// is the only thing that knows how it becomes pages, and it runs at image build
// time (web/Dockerfile), so the pages ship in the same container as the rest of
// the site.
//
// URLs follow the files:
//   README.md                       -> /
//   getting-started/README.md       -> /getting-started/
//   getting-started/ban-appeals.md  -> /getting-started/ban-appeals
//
// Links between pages are written in Markdown as relative .md paths, because
// that is what works on GitHub. They are rewritten to those URLs here.
//
// With no content (a local build without docs-content/), this writes one page
// saying so rather than failing — unless REQUIRE_DOCS=1, which the deploy sets,
// because a production image with no documentation is a broken deploy.

import fs from "node:fs";
import path from "node:path";
import { Marked } from "marked";

const [SRC, OUT] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error("usage: node render.mjs <docs-content-dir> <output-dir>");
  process.exit(2);
}

const ORIGIN = "https://docs.appealy.app";
const SITE = "https://appealy.app";

// ---------------------------------------------------------------------------
// Files and URLs
// ---------------------------------------------------------------------------

/** "getting-started/README.md" -> "/getting-started/"; "a/b.md" -> "/a/b". */
function routeFor(file) {
  const bare = file.replace(/\.md$/, "");
  if (bare === "README") return "/";
  if (bare.endsWith("/README")) return `/${bare.slice(0, -"README".length)}`;
  return `/${bare}`;
}

function outputFor(route) {
  return route.endsWith("/") ? `${route}index.html` : `${route}.html`;
}

function listMarkdown(dir, base = "") {
  const found = [];
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listMarkdown(dir, rel));
    else if (entry.name.endsWith(".md") && rel !== "SUMMARY.md") found.push(rel);
  }
  return found.sort();
}

/** SUMMARY.md's links, in order: the navigation. Headings group nothing on
 *  the page — the old site showed one flat list, and so does this. */
function readSummary(src) {
  const file = path.join(src, "SUMMARY.md");
  if (!fs.existsSync(file)) return [];
  const items = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*[*-]\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (m && m[2].endsWith(".md")) items.push({ title: m[1], file: m[2] });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slugify = (s) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");

/** Plain text of a token list, for titles and descriptions. */
function plain(tokens) {
  return (tokens ?? [])
    .map((t) => (t.tokens ? plain(t.tokens) : (t.text ?? t.raw ?? "")))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPage(file, markdown) {
  // Relative .md links become this site's URLs. Absolute URLs, root paths and
  // in-page anchors are left exactly as written.
  const rewriteLink = (token) => {
    if (token.type !== "link") return;
    const href = token.href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return;
    const [target, hash] = href.split("#");
    if (!target.endsWith(".md")) return;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    token.href = routeFor(resolved) + (hash ? `#${hash}` : "");
  };

  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slugify(plain(tokens))}">${inner}</h${depth}>\n`;
      },
      // A quote in these pages is always a callout, which the site styles.
      blockquote({ tokens }) {
        return `<div class="callout">${this.parser.parse(tokens)}</div>\n`;
      },
    },
  });

  const tokens = md.lexer(markdown);
  // Called explicitly: marked only runs walkTokens inside parse(), and this
  // lexes and renders as two steps so the title comes from the same tokens.
  md.walkTokens(tokens, rewriteLink);
  const h1 = tokens.find((t) => t.type === "heading" && t.depth === 1);
  const firstParagraph = tokens.find((t) => t.type === "paragraph");
  const description = plain(firstParagraph?.tokens);
  // Wide tables scroll inside their own box instead of the whole page. Done
  // here, not in a postprocess hook: hooks only run through parse(), and this
  // lexes once so the title and description come from the same tokens.
  const body = md
    .parser(tokens)
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, "</table></div>");
  return {
    title: h1 ? plain(h1.tokens) : "Documentation",
    description: description.length > 160 ? `${description.slice(0, 157).trimEnd()}…` : description,
    body,
  };
}

// ---------------------------------------------------------------------------
// Page shell — the marketing site's header and footer, with its links made
// absolute, because on this host "/pricing" does not exist.
// ---------------------------------------------------------------------------

function shell({ route, title, description, body, nav }) {
  const url = `${ORIGIN}${route}`;
  const fullTitle = `${title} — Appealy`;
  const navHtml = nav.length
    ? `      <nav aria-label="Documentation">
        <ul class="doc-nav">
${nav
  .map((n) => `        <li><a href="${n.route}"${n.route === route ? ' aria-current="page"' : ""}>${escapeHtml(n.title)}</a></li>`)
  .join("\n")}
        </ul>
      </nav>
`
    : "";
  const footerDocs = nav
    .filter((n) => n.route !== "/")
    .map((n) => `          <li><a href="${n.route}">${escapeHtml(n.title)}</a></li>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Generated by web/docs-renderer/render.mjs from the docs branch. Edit the Markdown, not this. -->
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Appealy">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:alt" content="Appealy — applications, ban appeals and tickets for your Discord server.">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(fullTitle)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${SITE}/og.png">

<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d1016">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f6f8">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/site.css">
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<header class="site-header">
  <div class="wrap">
    <a class="home" href="${SITE}/">
      <picture>
        <source media="(prefers-color-scheme: light)" srcset="/brand/wordmark-light.svg">
        <img src="/brand/wordmark.svg" alt="Appealy" width="360" height="80">
      </picture>
    </a>
    <nav class="site-nav" aria-label="Primary">
      <a href="${SITE}/#features">Features</a>
      <a href="${SITE}/pricing">Pricing</a>
      <a href="/">Docs</a>
      <a href="https://github.com/creeperdiamonds/appealy">GitHub</a>
      <a href="${SITE}/dashboard/">Dashboard</a>
    </nav>
  </div>
</header>

<main id="main">
  <div class="wrap">
    <article class="prose">

${navHtml}
${body}
    </article>
  </div>
</main>

<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <section>
        <h2>Product</h2>
        <ul>
          <li><a href="${SITE}/#features">Features</a></li>
          <li><a href="${SITE}/pricing">Pricing</a></li>
          <li><a href="${SITE}/dashboard/">Dashboard</a></li>
          <li><a href="${SITE}/status">Status</a></li>
        </ul>
      </section>
      <section>
        <h2>Use it for</h2>
        <ul>
          <li><a href="${SITE}/discord-ban-appeal-bot">Ban appeals</a></li>
          <li><a href="${SITE}/discord-ticket-bot">Tickets</a></li>
          <li><a href="${SITE}/discord-verification-bot">Verification</a></li>
          <li><a href="${SITE}/discord-anti-raid-bot">Anti-raid</a></li>
          <li><a href="${SITE}/discord-giveaway-bot">Giveaways</a></li>
        </ul>
      </section>
      <section>
        <h2>Docs</h2>
        <ul>
${footerDocs}
        </ul>
      </section>
      <section>
        <h2>Compare</h2>
        <ul>
          <li><a href="${SITE}/appy-alternative">Appy alternative</a></li>
          <li><a href="${SITE}/appeal-gg-alternative">Appeal.gg alternative</a></li>
          <li><a href="https://github.com/creeperdiamonds/appealy">GitHub repository</a></li>
          <li><a href="https://github.com/creeperdiamonds/appealy/blob/main/LICENSE">AGPL-3.0 licence</a></li>
        </ul>
      </section>
      <section>
        <h2>Legal</h2>
        <ul>
          <li><a href="${SITE}/privacy">Privacy</a></li>
          <li><a href="${SITE}/terms">Terms of Service</a></li>
        </ul>
      </section>
    </div>

    <p class="colophon">
      <img src="/brand/icon.svg" alt="" width="512" height="512">
      Appealy is free software under the GNU Affero General Public License v3.0. Not affiliated with
      Discord Inc. Discord is a trademark of Discord Inc. Appealy is also unaffiliated with, and a
      separate project from, Appy and Appeal.gg.
    </p>
  </div>
</footer>

</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function write(route, html) {
  const file = path.join(OUT, outputFor(route));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const hasContent = fs.existsSync(path.join(SRC, "README.md"));
if (!hasContent) {
  if (process.env.REQUIRE_DOCS === "1") {
    console.error(`No documentation found at ${SRC}. The deploy checks out the docs branch there; see web/docs-renderer/README.md.`);
    process.exit(1);
  }
  write("/", shell({
    route: "/",
    title: "Documentation",
    description: "The documentation was not included in this build.",
    body: `<h1>Documentation</h1>\n<p>This build was made without the docs branch, so there is nothing to show here. The documentation is at <a href="https://github.com/creeperdiamonds/appealy/tree/docs">the docs branch on GitHub</a>.</p>\n`,
    nav: [],
  }));
  console.log("docs: no content, wrote a placeholder page");
  process.exit(0);
}

const files = listMarkdown(SRC);
const summary = readSummary(SRC);
const nav = summary
  .filter((item) => files.includes(item.file))
  .map((item) => ({ title: item.title, route: routeFor(item.file) }));

const routes = [];
for (const file of files) {
  const route = routeFor(file);
  const page = renderPage(file, fs.readFileSync(path.join(SRC, file), "utf8"));
  write(route, shell({ route, ...page, nav }));
  routes.push(route);
  console.log(`docs: ${file} -> ${route}`);
}

// Canonical URLs only, matching each page's <link rel="canonical">. No
// <lastmod>: nothing here keeps it true.
const priority = (r) => (r === "/" ? "0.8" : r.split("/").filter(Boolean).length > 1 ? "0.6" : "0.7");
fs.writeFileSync(
  path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by web/docs-renderer/render.mjs. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map((r) => `  <url>\n    <loc>${ORIGIN}${r}</loc>\n    <priority>${priority(r)}</priority>\n  </url>`).join("\n")}
</urlset>
`,
);

// Same policy as appealy.app: public documentation, and being quoted with a
// link is the outcome we want.
fs.writeFileSync(
  path.join(OUT, "robots.txt"),
  `# Generated by web/docs-renderer/render.mjs. Same policy as appealy.app's robots.txt.
User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`,
);

console.log(`docs: ${routes.length} pages, sitemap.xml, robots.txt`);
