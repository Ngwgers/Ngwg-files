# Ngwg-files

Ngwg 的官方 parser/deployer 插件。CLI 在用户和主题未声明 `files` 时将它作为默认
回退来源；Core 不内置其实现。插件使用 npm 包，依赖在安装时或首次缺失 node_modules
时由 Bun 安装。

入口为 `src/index.ts`，清单为 `ngwg-plugin.yaml`。同一模块导出 parser、deployer、
helper 和 option 四类单元，见[插件协议](https://github.com/Ngwgers/Ngwg-docs/blob/main/plugin-protocol.md)。

## 配置

通过 CLI 使用官方默认来源时可省略 url；直接嵌入 Core 时须注入相应默认来源或显式
声明 URL/本地路径。

```yaml
plugins:
  files:
    option:
      chunk_size: 4000
      segment_threshold: 8000
      markdown:
        tex:
          enabled: false
          backend: katex
```

| 选项 | 当前行为 |
| --- | --- |
| `chunk_size` | 分段目标 HTML 字符数，默认 4000；任意负数禁用分段 |
| `segment_threshold` | 分段触发 HTML 字符数；优先于主题同名字段，未设置时使用主题值或 8000 |
| `markdown.tex.enabled` | 仅布尔 true 开启全局数学渲染，默认关闭 |
| `markdown.tex.backend` | `mathjax` 使用 MathJax，其余回退 KaTeX |

## Markdown 解析

`ngwg-markdown-parser` 处理 `.md` / `.markdown`。YAML frontmatter 通过 Core 提供的
`ctx.yaml.parse` 解析，文件在 `_posts/` 下才是文章；普通页面不会因为设置 date
自动成为文章。日期文件名前缀、slug、嵌套文章路径、permalink、hidden、pinned 等约定
见[主题与内容契约](https://github.com/Ngwgers/Ngwg-docs/blob/main/theme-development.md)。

Markdown 基于 markdown-it，启用原生 HTML、highlight.js 代码高亮、标题锚点，以及
缩写、脚注、mark、上下标、任务列表、tabs、admonition 和 alert 插件。原生 HTML
不会在这里做安全清洗；它适合作者可控的站点内容。

标题元数据优先使用 frontmatter title，再使用正文第一条非空、非 HTML 注释行
（该行是 ATX 标题时去掉标题符号），最后回退 slug；不会跨过开头段落专门寻找标题。

### 摘要与本地图片

`<!-- more -->` 前的内容成为 `excerptHtml`；文章的 `html` / `body` 仍保留完整正文，
该标记只移除自身。没有标记时 `excerptHtml` 未定义，由主题选择摘要回退。

正文中的简单行内图片 `![图](./pic.png)` 会读取本地文件、按内容 hash 改写到
`/assets/images/<hash>-<文件名>`，并返回对应的派生资源对象。同一文件的多个 owner
由 Core 跟踪，图片修改/删除会触发引用文章的增量重解析。

该提取基于行内图片正则，不覆盖全部 Markdown 图片语法：引用式图片、HTML img、复杂
路径/标题及带查询参数的链接不保证提取。远程、站点绝对路径和 data URI 保持原样。
图片读取失败时保留原链接，不生成占位图片。不要把这项功能视为独立的媒体处理器。

### 公式、图表和交互块

文章 frontmatter `tex: true` / `"katex"` / `"mathjax"` 可覆盖全局公式设置，false
关闭本篇。启用后支持 `$...$` 与 `$$...$$`。

- KaTeX 所需样式和字体复制到 `/assets/katex/`；主题需链接 katex.min.css。
- MathJax 生成 SVG，不需要浏览器再运行 MathJax。
- Mermaid 围栏输出 `<pre class="mermaid">`；检测到使用时复制运行时到
  `/assets/mermaid/mermaid.min.js`，主题负责加载并渲染。
- `::: tabs` / `@tab` 生成 tabs 结构，`@tab:active` 可标记初始项；切换由主题脚本实现。
- 任务列表、`!!!` admonition 和 `> [!NOTE]` 等 alert 的样式由主题提供。

`ngwg-markdown-helper` 将全局设置和文章/页面实际使用的 TeX 后端发布到
`site.extra.markdown.tex`。其中 `enabled` / `backend` 表示全局设置，`katex` /
`mathjax` 表示是否需要对应后端；不能只检查全局 enabled 来判断单篇公式是否启用。

## 页面部署

单元依次为：

1. `ngwg-ejs-deployer`：认领布局源文件后缀为 `.ejs` 的 page 任务。
2. `ngwg-template-deployer`：认领剩余 page 任务，使用受限 mustache 风格引擎。
3. `ngwg-fallback-deployer`：在所有常规 deployer 后认领尚未处理的任务，按字节复制
   资源；若 page 任务落到它手中则报错。

自定义 page deployer 应在 files 之前声明，否则通用 mustache 单元可能先认领任务。
文件扩展名不会自动安装相应引擎，例如 `.pug` 默认仍会被 mustache 单元认领。

| mustache 风格 | EJS |
| --- | --- |
| `{{ x }}` | `<%= x %>` |
| `{{{ x }}}` | `<%- x %>` |
| `{{@ helper a b }}` | `<%= h.helper(a, b) %>` |
| `{{> name }}` | `<%- partial('name') %>` 或 `<%- include('name') %>` |

EJS 的 partial/include 按 partial 自身后缀选择渲染方式；mustache partial 始终作为
mustache 文本渲染。include 从已加载的 partial 表读取，未知名称报错，不自动搜索任意
模板文件；EJS 本身可执行 JS，并可通过注入的 theme-scoped require 加载模块，所以这
不是模板代码沙箱。helpers 同步调用，`this` 绑定渲染根上下文。

两个 page deployer 共用 i18n 选择、布局回退与分段逻辑。语言表注入为 `t`、
`language`、`langAttr`；具体匹配与回退见[主题文档](https://github.com/Ngwgers/Ngwg-docs/blob/main/theme-development.md)。

## 长文分段

仅文章参与分段；普通页面不分段，文章 `no_segment: true` 可关闭。达到阈值后，
尝试在顶层 HTML 块边界按目标长度切分；单个大块不会强行撕开，因此阈值不是每段
长度上限，也不保证一定切成多段。

页面只携带第一段，其余写入文章目录的 `seg/2.html` 等。首个 `.post-seg-end` 标记的
`data-segments` 列出后续片段，`data-next` 指向下一片段。主题负责获取、按顺序插入
及锚点定位。部署阶段保留原 SourceObject 全文，不会把首段写回解析缓存。

没有 JavaScript 或主题加载器时，已分段文章不会自动显示全文；需要无脚本全文时
应关闭分段。更多输出和主题集成规则见[主题开发文档](https://github.com/Ngwgers/Ngwg-docs/blob/main/theme-development.md)。

## 许可证

[GNU General Public License v3.0 (GPL-3.0)](LICENSE)。
