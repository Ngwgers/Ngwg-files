// Ngwg-files — must-load Ngwg plugin implementing two protocols:
//
//   ngwg-parser-v1   : markdown/frontmatter source files → SourceObjects
//   ngwg-deployer-v1 : RenderTasks → rendered files under public/
//                      (mustache-style templates; see template.ts)
//
// The plugin intentionally implements only these two protocols — a plugin
// may implement any subset of the available protocols. It is fully
// self-contained: no imports from Ngwg-core, so it can be distributed and
// installed as a standalone repository.

import * as path from "node:path";
import { Pool } from "./pool.ts";
import { markdownToHtml, markdownTitle, splitMoreMarker } from "./markdown.ts";
import { render } from "./template.ts";
import { writeBytes, writeText } from "./write.ts";

// --- minimal structural types (mirror of Ngwg-core protocol definitions) ---

interface PluginContext {
  rootDir: string;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
  yaml: { parse(text: string): any };
  [k: string]: any;
}

interface SourceObject {
  path: string;
  relPath: string;
  url: string;
  kind: "post" | "page" | "asset";
  meta: Record<string, any>;
  body?: string;
  html?: string;
  excerptHtml?: string;
  raw?: Uint8Array;
  ext: string;
}

interface RenderTask {
  outPath: string;
  template?: string;
  context?: Record<string, any>;
  copy?: { content: Uint8Array };
}

// --- parser (ngwg-parser-v1) ------------------------------------------------

const POSTS_DIR = "_posts";
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;

export const parser = {
  protocol: "ngwg-parser-v1" as const,
  name: "files",
  version: "0.1.0",
  extensions: [".md", ".markdown"],

  async parseFile(ctx: PluginContext, filePath: string, content: Uint8Array): Promise<SourceObject | null> {
    const text = new TextDecoder().decode(content);
    const relPath = path.relative(ctx.rootDir, filePath).replace(/\\/g, "/");

    // frontmatter (YAML parsing uses the parser shipped with Ngwg-core)
    let meta: Record<string, any> = {};
    let body = text;
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (m) {
      try {
        meta = ctx.yaml.parse(m[1]) ?? {};
      } catch (e) {
        throw new Error(`${filePath}: invalid frontmatter — ${(e as Error).message}`);
      }
      if (typeof meta !== "object" || meta === null || Array.isArray(meta)) meta = {};
      body = text.slice(m[0].length);
    }

    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath, ext);

    // kind: files under source/_posts/ are posts, everything else is a page
    const relToSource = relPath.replace(/^source\//, "");
    const isPost = relToSource.startsWith(`${POSTS_DIR}/`);
    const kind: SourceObject["kind"] = isPost ? "post" : "page";

    // date & slug (frontmatter wins over the filename convention)
    let fileDate: Date | null = null;
    let slug = base;
    const dm = DATE_PREFIX.exec(base);
    if (dm) {
      fileDate = new Date(`${dm[1]}-${dm[2]}-${dm[3]}T12:00:00`);
      slug = dm[4];
    }
    if (meta.slug) slug = String(meta.slug);
    if (!meta.date && fileDate) meta.date = fileDate.toISOString().slice(0, 10);

    // normalize tags/categories to arrays so templates can always {{#each}}
    for (const field of ["tags", "categories"] as const) {
      const v = meta[field];
      if (typeof v === "string") {
        meta[field] = v.split(/[,，]/).map((s: string) => s.trim()).filter(Boolean);
      } else if (v !== undefined && v !== null && !Array.isArray(v)) {
        meta[field] = [String(v)];
      }
    }

    // /posts/<slug>/ for posts; directory-style URLs for pages
    //   about/index.md → /about/   about.md → /about/   index.md → /
    let pageUrl: string;
    if (relToSource === "index.md") pageUrl = "/";
    else if (relToSource.endsWith("/index.md")) pageUrl = `/${relToSource.slice(0, -"/index.md".length)}/`;
    else pageUrl = `/${relToSource.replace(/\.(md|markdown)$/, "")}/`;
    const url = meta.permalink ?? (isPost ? `/posts/${slug}/` : pageUrl);

    const title = meta.title ?? markdownTitle(body) ?? slug;

    // `<!-- more -->` marks the excerpt: everything before it is the short
    // version shown on listing pages (author-controlled 前言/摘要). The
    // article page itself keeps the full content — the marker only controls
    // what listings show.
    const { body: mainBody, excerptSource } = splitMoreMarker(body);
    const fullBody = excerptSource !== null ? excerptSource + mainBody : mainBody;

    return {
      path: filePath,
      relPath: relToSource,
      url: String(url),
      kind,
      ext,
      meta: {
        ...meta,
        title: String(title),
        slug,
        _fileDate: fileDate ?? undefined,
        date: meta.date ?? (fileDate ? fileDate.toISOString().slice(0, 10) : ""),
      },
      body: fullBody,
      html: markdownToHtml(fullBody),
      excerptHtml: excerptSource !== null ? markdownToHtml(excerptSource) : undefined,
    };
  },
};

// --- long-post segmentation (pjax incremental loading) ----------------------
//
// Posts whose rendered body exceeds the threshold are split into segments at
// block boundaries. The page ships only the first segment plus a marker
// pointing at the next one; the rest are written as small fragment files
// (seg/2.html, …) that the theme fetches lazily while the reader scrolls —
// a long article never has to be downloaded in one piece.

export const SEGMENT_DEFAULT_THRESHOLD = 8000;
export const SEGMENT_SIZE = 6000;

/**
 * Split rendered HTML into segments at *top-level* block boundaries
 * (a cut is only valid where the block-nesting depth is 0, so lists,
 * footnote sections and admonitions are never torn open). Returns null
 * when the body is short enough to ship as-is.
 */
export function splitHtmlSegments(
  html: string,
  threshold: number = SEGMENT_DEFAULT_THRESHOLD,
  size: number = SEGMENT_SIZE,
): string[] | null {
  if (html.length < threshold) return null;
  const tagRe = /<(\/?)(p|pre|ul|ol|li|blockquote|h[1-6]|div|table|figure|section)\b[^>]*>/g;
  const cuts: number[] = [];
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m[1] === "/") {
      if (depth > 0) depth--;
      if (depth === 0) cuts.push(m.index + m[0].length);
    } else if (!/\/>$/.test(m[0])) {
      depth++;
    }
  }
  const parts: string[] = [];
  let pos = 0;
  for (const cut of cuts) {
    if (cut - pos >= size && cut < html.length) {
      parts.push(html.slice(pos, cut));
      pos = cut;
    }
  }
  parts.push(html.slice(pos));
  return parts.length > 1 ? parts : null;
}

function segEndMarker(next: string | null): string {
  return next ? `<div class="post-seg-end" data-next="${next}"></div>` : "";
}

// --- deployer (ngwg-deployer-v1) ---------------------------------------------

export const deployer = {
  protocol: "ngwg-deployer-v1" as const,
  name: "files",
  version: "0.1.0",

  async deploy(ctx: PluginContext, env: any, tasks: RenderTask[]): Promise<void> {
    const pool = new Pool(8);
    const segThreshold = Number(env.theme?.config?.segment_threshold ?? SEGMENT_DEFAULT_THRESHOLD);
    await pool.run(tasks, async (task) => {
      ctx.log.debug(`write ${task.outPath}`);
      if (task.copy) {
        await writeBytes(task.outPath, task.copy.content);
        return;
      }
      const layoutName = task.template ?? "index";
      let tpl = env.theme.layouts[layoutName];
      if (tpl === undefined) {
        // graceful fallbacks: page/post → index
        if (env.theme.layouts.index !== undefined && (layoutName === "page" || layoutName === "post")) {
          tpl = env.theme.layouts.index;
          ctx.log.warn(`layout "${layoutName}" not found in theme — falling back to "index"`);
        } else {
          throw new Error(
            `layout "${layoutName}" not found in theme (available: ${Object.keys(env.theme.layouts).join(", ")})`,
          );
        }
      }

      // long-post segmentation: swap the body for its first segment + lazy
      // marker, write the remaining segments as sibling fragment files
      const page = task.context?.page;
      if (page && page.kind === "post" && typeof page.html === "string" && !page.meta.no_segment) {
        const segs = splitHtmlSegments(page.html, segThreshold);
        if (segs) {
          const baseDir = path.join(env.publicDir, String(page.url).replace(/^\//, ""));
          page.html = segs[0] + segEndMarker("seg/2.html");
          for (let k = 1; k < segs.length; k++) {
            const next = k + 1 < segs.length ? `seg/${k + 2}.html` : null;
            const file = path.join(baseDir, "seg", `${k + 1}.html`);
            ctx.log.debug(`write ${file}`);
            await writeText(file, segs[k] + segEndMarker(next));
          }
        }
      }

      const html = render(tpl, task.context ?? {}, env.helpers, env.theme.partials);
      await writeText(task.outPath, html);
    });
  },
};

export default { plugins: [parser, deployer] };
