// EJS integration for the Ngwg-files template deployer.
//
// Themes may mix template languages: a layout/partial whose source contains
// an EJS tag (`<% … %>`) is rendered by the npm `ejs` package, everything
// else by the built-in mustache-style engine (template.ts). The choice is
// made per source string — the theme loader keys templates by their
// extensionless file name, so the extension is not available here.
//
// Conversion rules (mustache → EJS):
//   {{ x }}            → <%= x %>          HTML-escaped output
//   {{{ x }}}          → <%- x %>          raw output
//   {{@ helper a b }}  → <%= h.helper(a, b) %>   helpers are reachable as `h`
//   {{ t.key }}        → <%= t.key %>      i18n strings stay on the root context
//   {{> name }}        → <%- include('name') %>  includes any partial, either language
//   {{#each xs }}…{{/each }} / {{#if x }}…{{/if }} → JS `for` / `if`
//
// Includes are resolved through the in-memory theme partials only (never the
// filesystem), and are dispatched at runtime so a single EJS layout can
// include mustache partials (and vice versa). Helpers are bound with `this`
// set to the page root context — that is how the i18n helper `t` reaches the
// selected language's string table (`this.t`).

import ejs from "ejs";
import { render } from "./template.ts";

export type HelperMap = Record<string, any>;

/** True when the source uses at least one EJS tag (drives engine selection). */
export function isEjsTemplate(src: string): boolean {
  return /<%/.test(src);
}

function resourceName(includePath: string): string {
  return String(includePath)
    .replace(/^\.\//, "")
    .replace(/\.ejs$/, "");
}

/**
 * Render an EJS template. `context` is the page root scope (site/page/t/
 * language/langAttr…); `helpers` is the merged helper table exposed to the
 * template as `h` and bound to `context`; `partials` maps partial names to
 * their source (any engine).
 */
export function renderEjs(
  template: string,
  context: Record<string, any>,
  helpers: HelperMap = {},
  partials: Record<string, string> = {},
): string {
  // helpers run with `this` bound to the page root context, exactly like the
  // mustache engine — the i18n helper `t` relies on reaching `this.t`
  const bound: HelperMap = {};
  for (const [name, fn] of Object.entries(helpers)) {
    bound[name] = typeof fn === "function" ? fn.bind(context) : fn;
  }

  // unified partial dispatcher: picks the engine per partial source
  const partial = (name: string, extra?: Record<string, any>): string => {
    const src = partials[name];
    if (src === undefined) throw new Error(`template: unknown partial "${name}"`);
    const ctx = extra ? { ...context, ...extra } : context;
    return isEjsTemplate(src) ? renderEjs(src, ctx, helpers, partials) : render(src, ctx, helpers, partials);
  };

  const locals = { ...context, h: bound, partial };

  return ejs.render(template, locals, {
    filename: "theme-layout.ejs",
    // Every include is served from the in-memory partial table; the returned
    // template calls `partial(name)` at render time (the include data is the
    // parent's own locals), so nested includes inherit the full context.
    // Unknown names throw instead of falling back to ejs's file loader, which
    // keeps includes from ever touching the filesystem (path traversal).
    includer: (includePath: string) => {
      const name = resourceName(includePath);
      if (partials[name] === undefined) {
        throw new Error(`template: unknown partial "${includePath}"`);
      }
      return { filename: `${name}.ejs`, template: `<%- partial(${JSON.stringify(name)}) %>` };
    },
  });
}
