// Ngwg-files — must-load Ngwg plugin implementing two protocols via units:
//
//   ngwg-parser-v1   : ngwg-markdown-parser — markdown/frontmatter source
//                      files → SourceObject array (the page object plus one
//                      derived object per referenced local image; images are
//                      re-homed to /assets/images/<hash>-<name> and the
//                      markdown links rewritten to those absolute URLs)
//   ngwg-deployer-v1 : ngwg-template-deployer — page tasks → rendered files
//                      under public/ (mustache-style templates; see template.ts)
//                      renders with the theme's i18n strings for the selected
//                      language (see resolveI18n)
//                      ngwg-fallback-deployer — safety net copying any task
//                      no other deployer claimed
//   ngwg-option-v1   : files-options — publishes the chunk_size option
//                      (long-post segmentation target length; negative
//                      disables segmentation)
//
// Every unit is independent and declares the files/tasks it handles; the
// module itself is fully self-contained: no imports from Ngwg-core, so it
// can be distributed and installed as a standalone repository.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "./pool.ts";
import { markdownToHtml, markdownTitle, splitMoreMarker } from "./markdown.ts";
import { render } from "./template.ts";
import { writeBytes, writeText } from "./write.ts";

// --- minimal structural types (mirror of Ngwg-core protocol definitions) ---

interface PluginContext {
  rootDir: string;
  log: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
  yaml: { parse(text: string): any };
  /** path relative to the configured source directory (posix separators) */
  relPath(filePath: string): string;
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

// --- parser unit (ngwg-parser-v1) --------------------------------------------

const POSTS_DIR = "_posts";
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})-(.+)$/;

// --- local image collection (unified asset placement) ------------------------
//
// Inline images referencing local files (`![x](./img/a.png)`) are extracted
// as derived SourceObjects and the markdown links are rewritten to their
// unified, content-addressed location /assets/images/<hash>-<name> — an
// absolute URL that works on any page depth without a <base> tag. Images
// shared by several posts hash to the same URL, so they deploy exactly once.

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp", ".ico"]);
const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g;

function localImagePath(src: string): string | null {
  if (!src || /^(https?:)?\/\//i.test(src) || src.startsWith("/") || src.startsWith("data:")) return null;
  let p = src;
  try {
    p = decodeURIComponent(src);
  } catch {
    // keep the raw spelling when it is not valid percent-encoding
  }
  return IMAGE_EXTS.has(path.extname(p).toLowerCase()) ? p : null;
}

async function collectImages(ctx: PluginContext, filePath: string, bodies: string[]) {
  const replacements = new Map<string, string>(); // src as written -> absolute URL
  const images: SourceObject[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(INLINE_IMAGE)) {
      const src = m[2];
      if (replacements.has(src)) continue;
      const rel = localImagePath(src);
      if (!rel) continue;
      const abs = path.resolve(path.dirname(filePath), rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(abs));
      } catch {
        continue; // missing or unreadable: leave the link untouched
      }
      const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
      const url = `/assets/images/${hash}-${path.basename(abs)}`;
      replacements.set(src, encodeURI(url));
      images.push({
        path: abs,
        relPath: ctx.relPath(abs),
        url,
        kind: "asset",
        ext: path.extname(abs).toLowerCase(),
        meta: {},
        raw: bytes,
      });
    }
  }
  const rewrite = (body: string): string =>
    replacements.size === 0
      ? body
      : body.replace(INLINE_IMAGE, (whole, alt: string, src: string, title?: string) =>
          replacements.has(src) ? `![${alt}](${replacements.get(src)}${title ?? ""})` : whole,
        );
  return { rewrite, images };
}

export const markdownParser = {
  name: "ngwg-markdown-parser",
  version: "0.2.0",
  extensions: [".md", ".markdown"],

  async parseFile(ctx: PluginContext, filePath: string, content: Uint8Array): Promise<SourceObject | null> {
    const text = new TextDecoder().decode(content);
    const relToSource = ctx.relPath(filePath);

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

    // /posts/<slug>/ for top-level posts, /posts/<subpath>/<slug>/ for posts
    // nested under _posts/ — subdirectories keep posts from colliding on the
    // same slug. Pages keep directory-style URLs:
    //   about/index.md → /about/   about.md → /about/   index.md → /
    const subPath = isPost
      ? relToSource.slice(POSTS_DIR.length + 1, relToSource.length - base.length - ext.length)
      : "";
    let pageUrl: string;
    if (relToSource === "index.md") pageUrl = "/";
    else if (relToSource.endsWith("/index.md")) pageUrl = `/${relToSource.slice(0, -"/index.md".length)}/`;
    else pageUrl = `/${relToSource.replace(/\.(md|markdown)$/, "")}/`;
    const url = meta.permalink ?? (isPost ? `/posts/${subPath}${slug}/` : pageUrl);

    const title = meta.title ?? markdownTitle(body) ?? slug;

    // `<!-- more -->` marks the excerpt: everything before it is the short
    // version shown on listing pages (author-controlled 前言/摘要). The
    // article page itself keeps the full content — the marker only controls
    // what listings show.
    const { body: mainBody, excerptSource } = splitMoreMarker(body);
    const { rewrite, images } = await collectImages(ctx, filePath, excerptSource === null ? [mainBody] : [excerptSource, mainBody]);
    const excerptHtml = excerptSource === null ? undefined : markdownToHtml(rewrite(excerptSource));
    const fullBody = (excerptSource === null ? "" : rewrite(excerptSource)) + rewrite(mainBody);

    // the primary object for the markdown file itself, plus one derived
    // object per referenced local image
    return [
      {
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
        excerptHtml,
      },
      ...images,
    ];
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
export const SEGMENT_SIZE = 4000;

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

// --- i18n (theme translation strings) ----------------------------------------
//
// Core reads the theme's i18n/<lang>.yaml files and the requested language
// (config `language` or $NGWG_LANG) and hands both over via the deploy env.
// The deployer resolves the final language — requested → theme default →
// first available — deep-merges the default language under the selected one
// and injects the result into every page's root render context as `t`, next
// to `language` (canonical lang_REGION, e.g. "zh_CN") and `langAttr`
// (BCP-47 style for <html lang>, e.g. "zh-CN"). A theme without i18n files
// simply renders with an empty `t`.

function normalizeLangTag(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim().split(/[.@]/)[0];
  const parts = s.replace(/-/g, "_").split("_").filter(Boolean);
  if (parts.length === 0 || !/^[a-z]+$/i.test(parts[0])) return "";
  const lang = parts[0].toLowerCase();
  if (parts[1] === undefined) return lang;
  return /^[a-z0-9]+$/i.test(parts[1]) ? `${lang}_${parts[1].toUpperCase()}` : lang;
}

function deepMergeStrings(base: any, over: any): any {
  if (over === undefined || over === null) return base;
  const plain =
    (v: any) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(base) || !plain(over)) return over;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMergeStrings(out[k], v);
  return out;
}

/**
 * Resolve the theme i18n strings for a deploy run. Returns the merged string
 * table plus the resolved language tag ("" when the theme ships no i18n).
 */
export function resolveI18n(
  i18n: Record<string, Record<string, any>>,
  requested: string | undefined,
  defaultLanguage: string | undefined,
): { strings: Record<string, any>; language: string } {
  const keys = Object.keys(i18n);
  if (keys.length === 0) return { strings: {}, language: "" };

  // exact lang_REGION → bare language → any region variant of that language
  const pick = (tag: string | undefined): string | undefined => {
    if (!tag) return undefined;
    if (keys.includes(tag)) return tag;
    const lang = tag.split("_")[0];
    if (lang !== tag && keys.includes(lang)) return lang;
    return keys.filter((k) => k.startsWith(`${lang}_`)).sort()[0];
  };

  const def = normalizeLangTag(defaultLanguage);
  const layers = [...new Set([pick(def), pick(requested)].filter((k): k is string => !!k))];
  if (layers.length > 0) {
    let strings: Record<string, any> = {};
    for (const k of layers) strings = deepMergeStrings(strings, i18n[k]);
    return { strings, language: layers[layers.length - 1] };
  }
  // nothing matched (or nothing requested/declared): deterministic first key
  return { strings: i18n[keys.sort()[0]], language: keys.sort()[0] };
}

// --- deployer units (ngwg-deployer-v1) ---------------------------------------

// Renders "page" tasks (theme layout + context) through the mustache-style
// template engine, including long-post segmentation.
export const templateDeployer = {
  name: "ngwg-template-deployer",
  version: "0.2.1",
  types: ["page" as const],

  async deploy(ctx: PluginContext, env: any, tasks: RenderTask[]): Promise<void> {
    const pool = new Pool(8);
    const segThreshold = Number(env.theme?.config?.segment_threshold ?? SEGMENT_DEFAULT_THRESHOLD);
    // chunk_size plugin option (plugins.<name>.option.chunk_size): target
    // segment length; any negative value disables segmentation entirely
    const rawChunk = (ctx.options as any)?.self?.chunk_size;
    const chunkSize = rawChunk === undefined ? SEGMENT_SIZE : Number(rawChunk);
    const segmentationEnabled = Number.isFinite(chunkSize) && chunkSize >= 0;

    // i18n: resolve the language for this whole deploy run
    const i18n: Record<string, Record<string, any>> = env.theme?.i18n ?? {};
    const requested = typeof env.language === "string" && env.language ? env.language : undefined;
    const { strings: tStrings, language } = resolveI18n(i18n, requested, env.theme?.config?.default_language);
    if (requested && language && language !== requested && !language.startsWith(`${requested.split("_")[0]}_`)) {
      ctx.log.warn(
        `language "${requested}" has no i18n file in this theme (available: ${Object.keys(i18n).sort().join(", ") || "none"}) — ` +
          `rendering with "${language}". Set "language" in ngwg.yaml or $NGWG_LANG to an available language.`,
      );
    } else if (!requested && !env.theme?.config?.default_language && Object.keys(i18n).length > 1) {
      ctx.log.warn(
        `theme i18n has ${Object.keys(i18n).length} languages and neither "language" (ngwg.yaml) nor $NGWG_LANG nor ` +
          `theme.yaml "default_language" is set — using "${language}". Declare default_language in theme.yaml.`,
      );
    }
    const langAttr = language.replace(/_/g, "-");

    await pool.run(tasks, async (task) => {
      ctx.log.debug(`write ${task.outPath}`);
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
      if (segmentationEnabled && page && page.kind === "post" && typeof page.html === "string" && !page.meta.no_segment) {
        const segs = splitHtmlSegments(page.html, segThreshold, chunkSize);
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

      // root render context: the task context plus the reserved i18n keys —
      // `t` (string table), `language` (lang_REGION) and `langAttr` (for
      // <html lang>). Helpers receive this object as `this`.
      const context = { ...(task.context ?? {}), t: tStrings, language, langAttr };
      const html = render(tpl, context, env.helpers, env.theme.partials);
      await writeText(task.outPath, html);
    });
  },
};

// The safety net: copies any task no other deployer claimed (theme assets,
// source files and binaries emitted by parsers). Page tasks reaching the
// fallback mean nothing claims page rendering — that is a misconfiguration,
// so it fails loudly instead of silently dropping pages.
export const fallbackDeployer = {
  name: "ngwg-fallback-deployer",
  version: "0.2.0",
  fallback: true,

  async deploy(ctx: PluginContext, _env: any, tasks: RenderTask[]): Promise<void> {
    const unrenderable: string[] = [];
    const pool = new Pool(8);
    await pool.run(tasks, async (task) => {
      if (!task.copy) {
        unrenderable.push(task.outPath);
        return;
      }
      ctx.log.debug(`fallback copy ${task.outPath}`);
      await writeBytes(task.outPath, task.copy.content);
    });
    if (unrenderable.length > 0) {
      throw new Error(
        `${unrenderable.length} page task(s) reached the fallback deployer (e.g. "${unrenderable[0]}") — ` +
          `no deployer claimed page rendering. Declare a page deployer (ngwg-deployer-v1, e.g. Ngwg-files) ` +
          `before the fallback in ngwg.yaml.`,
      );
    }
  },
};

// ngwg-option-v1: opts in to the option system and publishes chunk_size —
// the target segment length for long-post segmentation (any negative value
// disables segmentation; the per-post no_segment frontmatter still wins).
export const options = {
  name: "files-options",
  version: "0.2.1",
  public: ["chunk_size"],
  private: [],
  readShared: false,
};

export default { parsers: [markdownParser], deployers: [templateDeployer, fallbackDeployer], options: [options] };
