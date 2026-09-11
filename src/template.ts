// Mustache-style template engine (Ngwg-files deployer).
//
// Supported syntax:
//   {{ expr }}            HTML-escaped variable (dot paths, "." = current item)
//   {{{ expr }}}          raw (unescaped) variable
//   {{#each items}}…{{/each}}   loop; inside: "." = item, @index @key @first @last
//   {{#if cond}}…{{else}}…{{/if}}   truthiness branch
//   {{> partialName }}    include a theme partial
//   {{@ helper a b "c"}}  call a helper exposed by ngwg-helper-v1 plugins
//
// Arguments may be quoted strings, numbers, booleans, or context paths.

type Node =
  | { type: "text"; text: string }
  | { type: "var"; path: string; raw: boolean }
  | { type: "helper"; name: string; args: string[]; raw: boolean }
  | { type: "each"; path: string; body: Node[] }
  | { type: "if"; path: string; body: Node[]; elseBody: Node[] }
  | { type: "if-helper"; name: string; args: string[]; body: Node[]; elseBody: Node[] }
  | { type: "partial"; name: string };

export interface TemplateEnv {
  helpers: Record<string, (...args: any[]) => any>;
  partials: Record<string, string>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Tok {
  kind: "text" | "tag";
  value: string;
  raw: boolean;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let text = "";
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open < 0) {
      text += src.slice(i);
      break;
    }
    text += src.slice(i, open);
    const triple = src[open + 2] === "{";
    const close = src.indexOf(triple ? "}}}" : "}}", open + (triple ? 3 : 2));
    if (close < 0) throw new Error(`template: unterminated tag near "${src.slice(open, open + 30)}"`);
    const value = src.slice(open + (triple ? 3 : 2), close).trim();
    toks.push({ kind: "text", value: text, raw: false });
    text = "";
    toks.push({ kind: "tag", value, raw: triple });
    i = close + (triple ? 3 : 2);
  }
  if (text) toks.push({ kind: "text", value: text, raw: false });
  return toks;
}

function parseNodes(toks: Tok[], start: number, stop: string[] | null): [Node[], number] {
  const nodes: Node[] = [];
  let i = start;
  while (i < toks.length) {
    const tok = toks[i];
    if (tok.kind === "text") {
      if (tok.value) nodes.push({ type: "text", text: tok.value });
      i++;
      continue;
    }
    const v = tok.value;
    if (stop && stop.includes(v)) return [nodes, i]; // caller consumes the stop tag
    if (v.startsWith("#each ")) {
      const path = v.slice(6).trim();
      const [body, next] = parseNodes(toks, i + 1, ["/each"]);
      if (toks[next]?.value !== "/each") throw new Error(`template: {{#each ${path}}} without {{/each}}`);
      nodes.push({ type: "each", path, body });
      i = next + 1;
      continue;
    }
    if (v.startsWith("#if ")) {
      const cond = v.slice(4).trim();
      const [body, next] = parseNodes(toks, i + 1, ["else", "/if"]);
      let elseBody: Node[] = [];
      let after = next;
      if (toks[next]?.value === "else") {
        [elseBody, after] = parseNodes(toks, next + 1, ["/if"]);
      }
      if (toks[after]?.value !== "/if") throw new Error(`template: {{#if ${cond}}} without {{/if}}`);
      if (cond.startsWith("@ ")) {
        // helper call as condition: {{#if @ size site.tags }}
        const parts = splitArgs(cond.slice(2).trim());
        if (parts.length === 0) throw new Error("template: empty helper condition {{#if @ }}");
        nodes.push({ type: "if-helper", name: parts[0], args: parts.slice(1), body, elseBody });
      } else {
        nodes.push({ type: "if", path: cond, body, elseBody });
      }
      i = after + 1;
      continue;
    }
    if (v.startsWith("> ")) {
      nodes.push({ type: "partial", name: v.slice(2).trim() });
      i++;
      continue;
    }
    if (v.startsWith("@ ")) {
      const parts = splitArgs(v.slice(2).trim());
      if (parts.length === 0) throw new Error("template: empty helper call {{@ }}");
      nodes.push({ type: "helper", name: parts[0], args: parts.slice(1), raw: tok.raw });
      i++;
      continue;
    }
    if (v.startsWith("/")) throw new Error(`template: unexpected closing tag {{${v}}}`);
    nodes.push({ type: "var", path: v, raw: tok.raw });
    i++;
  }
  if (stop) throw new Error(`template: missing closing tag ${stop.join(" or ")}`);
  return [nodes, i];
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Resolve a path against the scope stack (innermost first, root last). */
function lookup(stack: any[], path: string): any {
  const top = stack[stack.length - 1];
  if (path === "." || path === "this") return top?.$item !== undefined ? top.$item : top;
  if (path.startsWith("@")) {
    const key = path.slice(1);
    for (let i = stack.length - 1; i >= 0; i--) {
      const meta = stack[i]?.$meta;
      if (meta && key in meta) return meta[key];
    }
    return undefined;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (scope && typeof scope === "object" && "$item" in scope) {
      const item = scope.$item;
      if (item !== null && typeof item === "object") {
        const v = getPath(item, path);
        if (v !== undefined) return v;
      }
    } else {
      const v = getPath(scope, path);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

function truthy(v: any): boolean {
  return !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === 0 ||
    (typeof v === "number" && isNaN(v)) ||
    (Array.isArray(v) && v.length === 0)
  );
}

function renderNodes(nodes: Node[], stack: any[], env: TemplateEnv): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.text;
        break;
      case "var": {
        const val = lookup(stack, node.path);
        if (val === undefined || val === null) continue;
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        out += node.raw ? str : escapeHtml(str);
        break;
      }
      case "helper": {
        const fn = env.helpers[node.name];
        if (typeof fn !== "function") {
          throw new Error(`template: unknown helper "${node.name}" — is the providing plugin loaded?`);
        }
        const args = node.args.map((a) => {
          if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a);
          if (a === "true") return true;
          if (a === "false") return false;
          if (a === "null") return null;
          return lookup(stack, a);
        });
        const val = fn(...args);
        if (val === undefined || val === null) continue;
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        out += node.raw ? str : escapeHtml(str);
        break;
      }
      case "each": {
        const val = lookup(stack, node.path);
        if (val === undefined || val === null) continue;
        if (!Array.isArray(val) && typeof val !== "object") {
          throw new Error(`template: {{#each ${node.path}}} needs an array or object, got ${typeof val}`);
        }
        if (Array.isArray(val)) {
          val.forEach((item, idx) => {
            const frame = { $item: item, $meta: { index: idx, first: idx === 0, last: idx === val.length - 1 } };
            out += renderNodes(node.body, [...stack, frame], env);
          });
        } else {
          const keys = Object.keys(val);
          keys.forEach((key, idx) => {
            const frame = { $item: val[key], $meta: { key, index: idx, first: idx === 0, last: idx === keys.length - 1 } };
            out += renderNodes(node.body, [...stack, frame], env);
          });
        }
        break;
      }
      case "if": {
        if (truthy(lookup(stack, node.path))) out += renderNodes(node.body, stack, env);
        else out += renderNodes(node.elseBody, stack, env);
        break;
      }
      case "if-helper": {
        const fn = env.helpers[node.name];
        if (typeof fn !== "function") {
          throw new Error(`template: unknown helper "${node.name}" in {{#if @ …}} — is the providing plugin loaded?`);
        }
        const args = node.args.map((a) => {
          if (/^-?\d+(\.\d+)?$/.test(a)) return Number(a);
          if (a === "true") return true;
          if (a === "false") return false;
          if (a === "null") return null;
          return lookup(stack, a);
        });
        if (truthy(fn(...args))) out += renderNodes(node.body, stack, env);
        else out += renderNodes(node.elseBody, stack, env);
        break;
      }
      case "partial": {
        const tpl = env.partials[node.name];
        if (tpl === undefined) throw new Error(`template: unknown partial "${node.name}"`);
        // the partial inherits the caller's full scope stack so "." keeps working
        out += renderStack(tpl, stack, env);
        break;
      }
    }
  }
  return out;
}

/**
 * Render a template against an explicit scope stack (innermost scope last).
 */
export function renderStack(template: string, stack: any[], env: TemplateEnv): string {
  const toks = tokenize(template);
  const [nodes] = parseNodes(toks, 0, null);
  return renderNodes(nodes, stack, env);
}

/**
 * Render a template. `context` is the root scope; `extraScopes` (used for
 * partials) keeps the caller's inner scopes so "." keeps working.
 */
export function render(
  template: string,
  context: Record<string, any>,
  helpers: Record<string, (...args: any[]) => any>,
  partials: Record<string, string> = {},
  extraScopes: any[] = [],
): string {
  return renderStack(template, [...extraScopes, context], { helpers, partials });
}
