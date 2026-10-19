# Ngwg-files

本仓库是提供 Ngwg 基本功能的内置插件。

清单：`ngwg-plugin.yaml`。

## 子模块

### ngwg-markdown-parser
实现 ngwg-parser-v1 。

本模块负责解析 Markdown 。基于 MarkdownIt 并启用了部分风味语法。

以下是使用的插件模块：


```js
import markdownItAdmonition from "markdown-it-admonition";
import { abbr } from "@mdit/plugin-abbr";
import { alert } from "@mdit/plugin-alert";
import { footnote } from "@mdit/plugin-footnote";
import { mark } from "@mdit/plugin-mark";
import { sub } from "@mdit/plugin-sub";
import { sup } from "@mdit/plugin-sup";
import anchor from "markdown-it-anchor";
```

**摘要标记**：正文中的 `<!-- more -->` 之前的部分会被解析为摘要，
并在首页等位置显示。此功能不会导致文章被切割。


### ngwg-ejs-deployer / ngwg-template-deployer
实现 ngwg-deployer-v1 。

两个 deployer 单元按 **layout 源码后缀** 分发页面任务（协议字段
`templateExtensions`）：

* `ngwg-ejs-deployer`：声明 `templateExtensions: [".ejs"]`，用 npm 的 `ejs`
  包渲染 `.ejs` 布局；
* `ngwg-template-deployer`：不声明后缀（认领其余任意后缀的布局），使用自实现的
  mustache 风格模板引擎。

两个单元声明顺序为 EJS 在前、mustache 在后，因此 `.ejs` 布局先被 EJS 单元认领，
其余布局由 mustache 单元兜底；主题因此可以逐个 layout 选择语言。EJS 布局内的
`include` 也按 partial 后缀分发：`.ejs` partial 走 EJS，其余走 mustache：

| mustache | EJS |
| --- | --- |
| `{{ x }}` | `<%= x %>` |
| `{{{ x }}}` | `<%- x %>` |
| `{{@ helper a b }}` | `<%= h.helper(a, b) %>`（helper 以 `h` 暴露，`this` 绑定页面根上下文） |
| `{{ t.key }}` | `<%= t.key %>` |
| `{{> name }}` | `<%- include('name') %>`（两种语言的 partial 都能包含） |

include 只从主题内存中的 partial 表解析，未知名字直接报错，绝不读写文件系统。

引擎只看扩展名，不再按模板内容猜测：需要在模板中字面展示 `<%` 时无需额外转义
（非 `.ejs` 文件不会进入 EJS）。

**长文分段**：渲染超过 `segment_threshold`（主题配置，默认 8000 字符）的文章时，
正文按顶层块边界切段：页面只带第一段，其余写入 `seg/N.html` 片段供主题懒加载。
切分目标段长由插件选项 `chunk_size` 控制（默认 4000，ngwg.yaml 写
`plugins.files.option.chunk_size`；任意负数整体禁用分段）。

### ngwg-fallback-deployer
实现 ngwg-deployer-v1。

本模块会认领没有被任何 deployer 认领的任务，将源文件直接复制到目标位置。

如果认领的是渲染任务将会报错。

## 许可证 / License

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 发布。
This project is licensed under the [GNU General Public License v3.0 (GPL-3.0)](LICENSE).

