// Markdown → HTML renderer (Ngwg-files).
//
// Migrated from fewu-swg/fewu-renderer-markdown (GPL-2.0-only, by 0xarch):
// markdown-it with html enabled, highlight.js code highlighting and the
// @mdit plugin suite — admonitions/alerts (`!!! note …`), footnotes (`[^1]`),
// abbreviations, ==mark==, sub-/superscript. Unlike the zero-dependency Core,
// this plugin deliberately uses npm packages to get a full Markdown dialect.
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
import anchor from "markdown-it-anchor";

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

const ADMONITION_TYPES = [
  "abstract", "attention", "caution", "error", "info", "note", "tip",
  "success", "question", "warning", "failure", "danger", "bug", "example", "quote",
];

md.use(abbr)
  .use(markdownItAdmonition, { types: ADMONITION_TYPES })
  .use(alert, { alertNames: ADMONITION_TYPES })
  .use(footnote)
  .use(mark)
  .use(sub)
  .use(sup)
  .use(anchor, {
    // stable ids for headings so themes can build a TOC; keeps CJK
    // characters readable instead of percent-encoding them
    slugify: (s: string) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section",
  });

export function markdownToHtml(src: string): string {
  return md.render(src);
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
