# Ngwg-files

must-load 插件，以三个独立单元实现两个协议：

- **ngwg-markdown-parser**（ngwg-parser-v1）— Markdown（含 YAML frontmatter）
  → SourceObject 数组（页面对象 + 每张引用的本地图片各一个派生对象）。
  `_posts/` 下的文件是文章（`2026-03-01-slug.md` 命名约定），其余是页面；
  正文里相对引用的本地图片统一安置到 `/assets/images/<内容hash>-<文件名>`，
  并把链接改写为该绝对 URL（多篇文章共用一张图只部署一份）；其他扩展名的
  文件由 Core 按资产原样复制。
- **ngwg-template-deployer**（ngwg-deployer-v1）— 渲染页面任务 → public/。
  自带 mustache 风格模板引擎（变量/循环/条件/partial/helper 调用），支持主题 i18n
  （按部署语言把翻译表注入 `t`/`language`/`langAttr` 上下文），语法见
  [主题开发](../Ngwg-docs/theme-development.md)。
- **ngwg-fallback-deployer**（ngwg-deployer-v1，`fallback: true`）— 兜底：
  把无人认领的任务原样复制进 public/；若页面渲染任务落到它（没有任何
  page deployer），会报错而不是静默丢页。

Markdown 渲染器迁移自 [fewu-renderer-markdown](https://github.com/0xarch)：
markdown-it + highlight.js + `@mdit/plugin-*`（admonition `!!! note`、脚注、
`==高亮==`、上下标、缩写），行内 HTML 透传。这是 Ngwg 中唯一使用 npm 依赖的
仓库——首次构建时 Core 会自动 `bun install`。

**长文分段**：渲染超过 `segment_threshold`（主题配置，默认 8000 字符）的文章时，
正文按顶层块边界切段：页面只带第一段，其余写入 `seg/N.html` 片段供主题懒加载。

**摘要标记**：正文中的 `<!-- more -->` 之前的部分解析为 `excerptHtml`
（首页等列表页显示的作者控制摘要）；文章页始终显示完整内容。

清单：`ngwg-plugin.yaml`。

## 许可证 / License

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 发布。
This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).

---

## English

# Ngwg-files

A must-load plugin implementing two protocols through three independent units:

- **ngwg-markdown-parser** (ngwg-parser-v1) — Markdown (with YAML frontmatter) → an array of SourceObjects (the page object plus one derived object per referenced local image). Files under `_posts/` are posts (following the `2026-03-01-slug.md` naming convention), everything else is a page; locally referenced images are re-homed to `/assets/images/<content-hash>-<name>` with their links rewritten to those absolute URLs (images shared by several posts deploy once); files with other extensions are copied as assets by Core.
- **ngwg-template-deployer** (ngwg-deployer-v1) — renders page tasks → public/. Ships a mustache-style template engine (variables/loops/conditionals/partial/helper calls) with theme i18n support (injects the translation table as `t`/`language`/`langAttr` for the selected language); see [Theme Development](../Ngwg-docs/theme-development.md) for the syntax.
- **ngwg-fallback-deployer** (ngwg-deployer-v1, `fallback: true`) — the safety net: copies any task no other deployer claimed; page tasks reaching it fail the build loudly instead of silently dropping pages.

The Markdown renderer is migrated from [fewu-renderer-markdown](https://github.com/0xarch): markdown-it + highlight.js + `@mdit/plugin-*` (admonitions `!!! note`, footnotes, `==highlight==`, sub/superscript, abbreviations), with inline HTML passed through. This is the only repository in Ngwg that uses npm dependencies — Core automatically runs `bun install` on the first build.

**Long-post segmentation**: when rendering a post longer than `segment_threshold` (a theme option, 8000 characters by default), the body is split at top-level block boundaries: the page only carries the first segment, and the rest are written to `seg/N.html` fragments for themes to lazy-load.

**Excerpt marker**: the part of the body before `<!-- more -->` is parsed as `excerptHtml` (the author-controlled excerpt shown on list pages such as the home page); the post page always shows the full content.

Manifest: `ngwg-plugin.yaml`.

## License

This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
