// EJS integration for the Ngwg-files template deployer.
//
// The engine is chosen by *file suffix*, not by inspecting template syntax:
// the EJS unit declares `templateExtensions: [".ejs"]`, the mustache unit
// claims every other page layout. Inside an EJS layout, includes are
// dispatched per partial suffix the same way (a `.ejs` partial is rendered by
// EJS, anything else by the mustache engine).
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
// filesystem). Helpers are bound with `this` set to the page root context —
// that is how the i18n helper `t` reaches the selected language's string
// table (`this.t`).
//
// npm dependencies: a theme may declare packages in its own package.json (e.g.
// the icon sets the original theme uses). The deployer hands the engine a
// module loader rooted at the *theme directory* (`options.require`), exposed to
// templates as `require`, so a layout/partial can use them without the theme
// vendoring any of their data. Templates cannot do this on their own: the
// engine's include/scope sandbox has no module resolution and no theme path.

import ejs from "ejs";
import { render } from "./template.ts";

export type HelperMap = Record<string, any>;

export interface EjsRenderOptions {
  /**
   * Theme-scoped module loader: bare specifiers resolve from the theme
   * directory's node_modules. Exposed to the template as `require(id)`.
   * Absent when the caller has no theme root — templates then see the
   * host's own `require`, if any.
   */
  require?: (id: string) => any;
  /**
   * Sinks for template-level messages, exposed to the template as `warn(msg)`
   * and `debug(msg)` so a theme's messages honour the build's log level and
   * formatting instead of writing to the console directly (`debug` is the
   * verbose-only channel, for notes that are useful but not actionable).
   * Absent → templates fall back to `console.warn` / `console.debug`.
   */
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
}

/** Suffixes rendered by the EJS engine (kept in sync with the EJS unit). */
export const EJS_EXTENSIONS = [".ejs"];

function isEjsExt(ext: string | undefined): boolean {
  return ext !== undefined && EJS_EXTENSIONS.includes(ext.toLowerCase());
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
 * their source and `partialExts` maps them to their source suffix (any
 * engine).
 */
export function renderEjs(
  template: string,
  context: Record<string, any>,
  helpers: HelperMap = {},
  partials: Record<string, string> = {},
  partialExts: Record<string, string> = {},
  options: EjsRenderOptions = {},
): string {
  // helpers run with `this` bound to the page root context, exactly like the
  // mustache engine — the i18n helper `t` relies on reaching `this.t`
  const bound: HelperMap = {};
  for (const [name, fn] of Object.entries(helpers)) {
    bound[name] = typeof fn === "function" ? fn.bind(context) : fn;
  }

  // unified partial dispatcher: picks the engine per partial suffix
  const partial = (name: string, extra?: Record<string, any>): string => {
    const src = partials[name];
    if (src === undefined) throw new Error(`template: unknown partial "${name}"`);
    const ctx = extra ? { ...context, ...extra } : context;
    return isEjsExt(partialExts[name])
      ? renderEjs(src, ctx, helpers, partials, partialExts, options)
      : render(src, ctx, helpers, partials);
  };

  const locals: Record<string, any> = { ...context, h: bound, partial };
  // the loader and the message sinks are EJS-only and are not part of the
  // (data) page context, so they are added here instead of being threaded
  // through every caller
  if (options.require) locals.require = options.require;
  if (options.warn) locals.warn = options.warn;
  if (options.debug) locals.debug = options.debug;

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
