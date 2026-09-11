# Ngwg-files

must-load 插件，实现两个协议：

- **ngwg-parser-v1** — Markdown（含 YAML frontmatter）→ SourceObject。
  `_posts/` 下的文件是文章（`2026-03-01-slug.md` 命名约定），其余是页面；
  其他扩展名的文件由 Core 按资产原样复制。
- **ngwg-deployer-v1** — 渲染任务 → public/。自带 mustache 风格模板引擎
  （变量/循环/条件/partial/helper 调用），语法见
  [主题开发](../Ngwg-docs/theme-development.md)。

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

A must-load plugin implementing two protocols:

- **ngwg-parser-v1** — Markdown (with YAML frontmatter) → SourceObject. Files under `_posts/` are posts (following the `2026-03-01-slug.md` naming convention), everything else is a page; files with other extensions are copied as assets by Core.
- **ngwg-deployer-v1** — render tasks → public/. Ships a mustache-style template engine (variables/loops/conditionals/partial/helper calls); see [Theme Development](../Ngwg-docs/theme-development.md) for the syntax.

The Markdown renderer is migrated from [fewu-renderer-markdown](https://github.com/0xarch): markdown-it + highlight.js + `@mdit/plugin-*` (admonitions `!!! note`, footnotes, `==highlight==`, sub/superscript, abbreviations), with inline HTML passed through. This is the only repository in Ngwg that uses npm dependencies — Core automatically runs `bun install` on the first build.

**Long-post segmentation**: when rendering a post longer than `segment_threshold` (a theme option, 8000 characters by default), the body is split at top-level block boundaries: the page only carries the first segment, and the rest are written to `seg/N.html` fragments for themes to lazy-load.

**Excerpt marker**: the part of the body before `<!-- more -->` is parsed as `excerptHtml` (the author-controlled excerpt shown on list pages such as the home page); the post page always shows the full content.

Manifest: `ngwg-plugin.yaml`.

## License

This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).
