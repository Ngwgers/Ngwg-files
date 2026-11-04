// Markdown → HTML renderer (Ngwg-files).
//
// Migrated from fewu-swg/fewu-renderer-markdown (GPL-2.0-only, by 0xarch):
// markdown-it with html enabled, highlight.js code highlighting and the
// @mdit plugin suite — admonitions/alerts (`!!! note …` / `> [!NOTE]`),
// footnotes (`[^1]`), abbreviations, ==mark==, sub-/superscript, task lists,
// tab containers and optional TeX. Unlike the zero-dependency Core, this
// plugin deliberately uses npm packages to get a full Markdown dialect.
//
// TeX is opt-in (it is expensive): `plugins.files.option.markdown.tex.enabled`
// turns it on, `markdown.tex.backend` picks KaTeX (default) or MathJax, and a
// post's frontmatter `tex: true | "katex" | "mathjax"` overrides the global
// setting. Mermaid fences are emitted as `<pre class="mermaid">source</pre>`;
// the theme renders them in the browser with Mermaid's own runtime.
//
// Also provides markdownTitle (first heading / first line heuristic).

import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
// markdown-it-admonition looks abandoned; kept for parity with the fewu
// renderer it was migrated from. @ts-ignore silences its missing types.
// @ts-ignore
import markdownItAdmonition from "markdown-it-admonition";
import { abbr } from "@mdit/plugin-abbr";
import { alert } from "@mdit/plugin-alert";
import { footnote } from "@mdit/plugin-footnote";
import { mark } from "@mdit/plugin-mark";
import { sub } from "@mdit/plugin-sub";
import { sup } from "@mdit/plugin-sup";
import { tasklist } from "@mdit/plugin-tasklist";
import { tab } from "@mdit/plugin-tab";
import { katex } from "@mdit/plugin-katex";
import { createMathjaxInstance, mathjax } from "@mdit/plugin-mathjax";
import MermaidIt from "mermaid-it-markdown";
import anchor from "markdown-it-anchor";

const ADMONITION_TYPES = [
  "abstract", "attention", "caution", "error", "important", "info", "note", "tip",
  "success", "question", "warning", "failure", "danger", "bug", "example", "quote",
];

export type TexBackend = "mathjax" | "katex";

export interface TexConfig {
  enabled: boolean;
  backend: TexBackend;
}

export interface MarkdownConfig {
  tex?: Partial<TexConfig> & { backend?: string };
}

/** Normalize the plugin option surface (`markdown.tex`) to a full config. */
export function resolveTexConfig(raw: any): TexConfig {
  const tex = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: tex.enabled === true,
    backend: tex.backend === "mathjax" ? "mathjax" : "katex",
  };
}

/**
 * Frontmatter `tex` wins over the global setting:
 *   true / "katex" → KaTeX, "mathjax" → MathJax, false → off.
 */
export function texForPage(global: TexConfig, frontmatter: any): TexConfig {
  if (frontmatter === true || frontmatter === "katex") return { enabled: true, backend: "katex" };
  if (frontmatter === "mathjax") return { enabled: true, backend: "mathjax" };
  if (frontmatter === false) return { enabled: false, backend: global.backend };
  return global;
}

const rendererCache = new Map<string, MarkdownIt>();

function createRenderer(config: MarkdownConfig): MarkdownIt {
  const md = MarkdownIt({
    html: true,
    highlight(str: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch {
          // fall through to plain escaping
        }
      }
      return md.utils.escapeHtml(str);
    },
  });

  md.use(abbr)
    .use(markdownItAdmonition, { types: ADMONITION_TYPES })
    .use(alert, { alertNames: ADMONITION_TYPES })
    .use(footnote)
    .use(mark)
    .use(sub)
    .use(sup)
    .use(tasklist)
    .use(tab);

  // Mermaid: mermaid-it-markdown is browser-only (it emits a placeholder and
  // renders through `document`), so keep its detection/initialisation but
  // emit the diagram source instead. The theme runs Mermaid on `.mermaid`.
  const defaultFence = md.renderer.rules.fence;
  md.use(MermaidIt);
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim() === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  const tex = resolveTexConfig(config.tex);
  if (tex.enabled) {
    if (tex.backend === "mathjax") {
      // mathjax() requires the instance created by createMathjaxInstance()
      const instance = createMathjaxInstance();
      if (instance) md.use(mathjax, instance);
    } else {
      md.use(katex);
    }
  }

  md.use(anchor, {
    // stable ids for headings so themes can build a TOC; keeps CJK
    // characters readable instead of percent-encoding them
    slugify: (s: string) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section",
  });

  return md;
}

function getRenderer(config: MarkdownConfig = {}): MarkdownIt {
  const tex = resolveTexConfig(config.tex);
  const key = `${tex.enabled ? 1 : 0}:${tex.backend}`;
  let md = rendererCache.get(key);
  if (!md) {
    md = createRenderer({ tex });
    rendererCache.set(key, md);
  }
  return md;
}

export function markdownToHtml(src: string, config: MarkdownConfig = {}): string {
  return getRenderer(config).render(src);
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** First markdown heading, or first non-empty line — used as fallback title. */
export function markdownTitle(src: string): string | null {
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("<!--")) continue;
    const h = HEADING.exec(t);
    if (h) return h[2];
    return t;
  }
  return null;
}

/**
 * Split a markdown body at the `<!-- more -->` marker (whitespace inside the
 * comment is allowed, case-insensitive). Everything before the marker becomes
 * the excerpt (前言/摘要 — the short version shown on listing pages), giving
 * authors precise control over what is shown there. Returns the body with the
 * marker removed, plus the pre-marker part when the marker was present.
 */
export function splitMoreMarker(body: string): { body: string; excerptSource: string | null } {
  const re = /<!--\s*more\s*-->/i;
  const idx = body.search(re);
  if (idx < 0) return { body, excerptSource: null };
  return {
    body: body.slice(idx).replace(re, ""),
    excerptSource: body.slice(0, idx),
  };
}
