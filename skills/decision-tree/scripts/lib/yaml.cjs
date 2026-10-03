"use strict";

/** Dependency-free parser and serializer for the YAML subset templates use. */

const { DTError, isPlainObject, hasOwn } = require("./util.cjs");

const SEQ_ITEM_RE = /^-(\s|$)/;

function stripComment(s) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "#" && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
  }
  return s.trimEnd();
}

/** Index of the closing quote of the quoted string starting at `start`, or -1. */
function quotedEnd(s, start = 0) {
  const q = s[start];
  for (let k = start + 1; k < s.length; k++) {
    if (q === '"' && s[k] === "\\") k++;
    else if (q === "'" && s[k] === "'" && s[k + 1] === "'") k++;
    else if (s[k] === q) return k;
  }
  return -1;
}

function plainScalar(s) {
  if (/^(~|null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s);
  return s;
}

const YAML_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/", " ": " ", 0: "\0" };

/**
 * Parser for the YAML subset used by templates: comments, block mappings and sequences,
 * plain/quoted scalars, single-line flow sequences of scalars, `[]`/`{}`, and `|`/`>` blocks.
 * Anything else raises a DTError with `file:line`.
 */
class YamlParser {
  constructor(text, file) {
    this.file = file || "<yaml>";
    this.lines = String(text).replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
    if (this.lines.length > 1 && this.lines[this.lines.length - 1] === "") this.lines.pop();
    this.i = 0;
    this.started = false;
  }

  fail(msg) {
    throw new DTError(`${this.file}:${Math.min(this.i, this.lines.length - 1) + 1}: ${msg}`);
  }

  /** Next significant line as {indent, text}, skipping blanks and comments; null at EOF. */
  peek() {
    while (this.i < this.lines.length) {
      const m = /^([ \t]*)(.*)$/.exec(this.lines[this.i]);
      const text = m[2].trimEnd();
      if (!text || text.startsWith("#")) {
        this.i++;
        continue;
      }
      if (m[1].includes("\t")) this.fail("tabs are not allowed for indentation; use spaces");
      const indent = m[1].length;
      if (indent === 0 && /^---(\s|$)/.test(text)) {
        if (this.started) this.fail("multiple documents ('---') are not supported");
        if (stripComment(text.slice(3)).trim()) this.fail("content after '---' is not supported");
        this.started = true;
        this.i++;
        continue;
      }
      if (indent === 0 && /^\.\.\.(\s|$)/.test(text)) this.fail("document end marker ('...') is not supported");
      if (indent === 0 && text.startsWith("%")) this.fail("YAML directives ('%') are not supported");
      this.started = true;
      return { indent, text };
    }
    return null;
  }

  parse() {
    if (!this.peek()) return null;
    const value = this.node();
    if (this.peek()) this.fail("unexpected content (check the indentation)");
    return value;
  }

  node() {
    const ln = this.peek();
    if (SEQ_ITEM_RE.test(ln.text)) return this.seq(ln.indent);
    if (this.splitKey(ln.text)) return this.map(ln.indent);
    return this.value(ln.text, ln.indent - 1, false);
  }

  /** `key: rest` → {key, rest}; null if the line is not a mapping entry. */
  splitKey(text) {
    if (text === "?" || text.startsWith("? ")) this.fail("complex keys ('? ') are not supported");
    if (text[0] === '"' || text[0] === "'") {
      const end = quotedEnd(text);
      if (end < 0) return null;
      const m = /^\s*:(\s|$)/.exec(text.slice(end + 1));
      if (!m) return null;
      return { key: this.quoted(text.slice(0, end + 1)), rest: text.slice(end + 1 + m[0].length).trim() };
    }
    if (/^[[\]{}&*!|>%@`,#]/.test(text)) return null;
    const m = /:(\s|$)/.exec(text);
    if (!m) return null;
    const key = text.slice(0, m.index).trimEnd();
    if (/\s#/.test(key)) return null;
    return { key, rest: text.slice(m.index + 1).trim() };
  }

  map(indent) {
    const out = {};
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) this.fail("unexpected indentation (multi-line plain scalars are not supported; use | or quotes)");
      if (SEQ_ITEM_RE.test(ln.text)) this.fail("unexpected list item inside a mapping (check the indentation)");
      const kv = this.splitKey(ln.text);
      if (!kv) this.fail("expected a 'key: value' mapping entry");
      if (hasOwn(out, kv.key)) this.fail(`duplicate key ${JSON.stringify(kv.key)}`);
      const value = this.value(kv.rest, indent, true);
      Object.defineProperty(out, kv.key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }

  seq(indent) {
    const out = [];
    for (;;) {
      const ln = this.peek();
      if (!ln || ln.indent < indent) break;
      if (ln.indent > indent) this.fail("unexpected indentation (check the list item alignment)");
      if (!SEQ_ITEM_RE.test(ln.text)) break;
      const after = ln.text.slice(1);
      if (/^ *\t/.test(after)) this.fail("tabs are not allowed for indentation; use spaces");
      const rest = after.trimStart();
      if (rest && !rest.startsWith("#") && (SEQ_ITEM_RE.test(rest) || this.splitKey(rest))) {
        const col = indent + 1 + (after.length - rest.length);
        this.lines[this.i] = " ".repeat(col) + rest;
        out.push(this.node());
      } else {
        out.push(this.value(rest, indent, false));
      }
    }
    return out;
  }

  /** Value after `key:` or `- ` on the current line; nested blocks must be indented past `parentIndent`. */
  value(rest, parentIndent, inMap) {
    if (!rest || rest.startsWith("#")) {
      this.i++;
      const next = this.peek();
      if (next && (next.indent > parentIndent || (inMap && next.indent === parentIndent && SEQ_ITEM_RE.test(next.text)))) {
        return this.node();
      }
      return null;
    }
    if (rest[0] === "|" || rest[0] === ">") return this.block(rest, parentIndent);
    const v = this.scalar(rest);
    this.i++;
    return v;
  }

  checkTail(tail) {
    if (tail.trim() && !/^\s+#/.test(tail)) this.fail(`unexpected text after value: ${JSON.stringify(tail.trim())}`);
  }

  quoted(s) {
    const inner = s.slice(1, -1);
    if (s[0] === "'") return inner.replace(/''/g, "'");
    return inner.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, ch) => {
      if (ch.length === 5) return String.fromCharCode(parseInt(ch.slice(1), 16));
      if (!hasOwn(YAML_ESCAPES, ch)) this.fail(`unsupported escape '\\${ch}' in double-quoted string`);
      return YAML_ESCAPES[ch];
    });
  }

  rejectSpecial(c) {
    if (c === "&") this.fail("anchors ('&') are not supported");
    if (c === "*") this.fail("aliases ('*') are not supported");
    if (c === "!") this.fail("tags ('!') are not supported");
    if (c === "@" || c === "`") this.fail(`a plain value cannot start with '${c}'; quote it`);
  }

  scalar(text) {
    const c = text[0];
    this.rejectSpecial(c);
    if (c === '"' || c === "'") {
      const end = quotedEnd(text);
      if (end < 0) this.fail("unterminated quoted string (multi-line quoted strings are not supported; use |)");
      this.checkTail(text.slice(end + 1));
      return this.quoted(text.slice(0, end + 1));
    }
    if (c === "[") return this.flowSeq(text);
    if (c === "{") {
      const m = /^\{\s*\}(.*)$/.exec(text);
      if (!m) this.fail("flow mappings ('{...}') are not supported; use a block mapping");
      this.checkTail(m[1]);
      return {};
    }
    const v = stripComment(text);
    if (/:(\s|$)/.test(v)) this.fail("unexpected ': ' in a plain value; quote the string");
    return plainScalar(v);
  }

  flowSeq(text) {
    const items = [];
    let k = 1;
    const ws = () => {
      while (k < text.length && /\s/.test(text[k])) k++;
    };
    ws();
    if (text[k] === "]") k++;
    else {
      for (;;) {
        ws();
        const c = text[k];
        if (c === undefined) this.fail("unterminated flow sequence (it must close with ']' on the same line)");
        this.rejectSpecial(c);
        if (c === "[" || c === "{") this.fail("nested flow collections are not supported");
        if (c === "," || c === "]") this.fail("empty item in flow sequence");
        if (c === '"' || c === "'") {
          const end = quotedEnd(text, k);
          if (end < 0) this.fail("unterminated quoted string in flow sequence");
          items.push(this.quoted(text.slice(k, end + 1)));
          k = end + 1;
        } else {
          let e = k;
          while (e < text.length && text[e] !== "," && text[e] !== "]" && !(text[e] === "#" && /\s/.test(text[e - 1]))) e++;
          const raw = text.slice(k, e).trim();
          if (/:(\s|$)/.test(raw)) this.fail("mappings inside flow sequences are not supported");
          items.push(plainScalar(raw));
          k = e;
        }
        ws();
        if (text[k] === ",") {
          k++;
          ws();
          if (text[k] === "]") {
            k++;
            break;
          }
          continue;
        }
        if (text[k] === "]") {
          k++;
          break;
        }
        this.fail("expected ',' or ']' in flow sequence (it must close on the same line)");
      }
    }
    this.checkTail(text.slice(k));
    return items;
  }

  block(header, parentIndent) {
    const m = /^([|>])([+-]?)(\s+#.*)?$/.exec(header);
    if (!m) this.fail(`unsupported block scalar header ${JSON.stringify(header)} (use |, |-, |+, >, >- or >+)`);
    this.i++;
    let ind = null;
    const body = [];
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i];
      if (raw.trim()) {
        const lead = raw.length - raw.replace(/^ +/, "").length;
        if (ind === null) {
          if (lead <= parentIndent) break;
          if (raw[lead] === "\t") this.fail("tabs are not allowed for indentation; use spaces");
          ind = lead;
        } else if (lead < ind) break;
      }
      body.push(raw);
      this.i++;
    }
    if (ind === null) return m[2] === "+" ? "\n".repeat(body.length) : "";
    const lines = body.map((l) => (l.length > ind ? l.slice(ind) : ""));
    let n = lines.length;
    while (n && !lines[n - 1].trim()) n--;
    const content = lines.slice(0, n);
    const text = m[1] === "|" ? content.join("\n") : foldLines(content);
    if (m[2] === "-") return text;
    if (m[2] === "+") return text + "\n".repeat(lines.length - n + 1);
    return text + "\n";
  }
}

function foldLines(lines) {
  let out = "";
  let prev = null;
  let blanks = 0;
  for (const l of lines) {
    if (!l.trim()) {
      blanks++;
      out += "\n";
      continue;
    }
    if (prev === null) out += l;
    else {
      const more = /^\s/.test(l) || /^\s/.test(prev);
      out += blanks ? (more ? "\n" : "") + l : (more ? "\n" : " ") + l;
    }
    prev = l;
    blanks = 0;
  }
  return out;
}

function parseYaml(text, file) {
  return new YamlParser(text, file).parse();
}

const hasControlChars = (s, allowNewline = false) =>
  [...s].some((ch) => {
    const c = ch.charCodeAt(0);
    return (c < 0x20 || c === 0x7f) && !(allowNewline && ch === "\n");
  });

function yamlNeedsQuotes(s, flow) {
  return (
    s === "" ||
    s !== s.trim() ||
    hasControlChars(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:(\s|$)|\s#/.test(s) ||
    (flow && /[,[\]{}]/.test(s)) ||
    plainScalar(s) !== s
  );
}

function yamlScalar(v, flow = false) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return yamlNeedsQuotes(s, flow) ? JSON.stringify(s) : s;
}

function yamlBlockable(s) {
  if (!s.includes("\n") || hasControlChars(s, true)) return false;
  const lines = s.replace(/\n+$/, "").split("\n");
  const first = lines.find((l) => l !== "");
  return first !== undefined && !/^\s/.test(first) && !lines.some((l) => l !== "" && !l.trim());
}

function yamlEntry(prefix, v, pad) {
  if (Array.isArray(v)) {
    if (!v.length) return [`${prefix} []`];
    if (v.every((x) => !isPlainObject(x) && !Array.isArray(x))) {
      const flow = `${prefix} [${v.map((x) => yamlScalar(x, true)).join(", ")}]`;
      if (flow.length <= 100) return [flow];
    }
  }
  if (isPlainObject(v) && !Object.keys(v).length) return [`${prefix} {}`];
  if (Array.isArray(v) || isPlainObject(v)) {
    const sub = yamlLines(v, pad);
    if (prefix.endsWith("-")) return [`${prefix} ${sub[0].slice(pad.length)}`, ...sub.slice(1)];
    return [prefix, ...sub];
  }
  if (typeof v === "string" && yamlBlockable(v)) {
    const trailing = /\n*$/.exec(v)[0].length;
    const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
    const lines = v.replace(/\n+$/, "").split("\n");
    for (let k = 1; k < trailing; k++) lines.push("");
    return [`${prefix} |${chomp}`, ...lines.map((l) => (l ? pad + l : ""))];
  }
  return [`${prefix} ${yamlScalar(v)}`];
}

function yamlLines(v, pad) {
  if (Array.isArray(v)) return v.flatMap((item) => yamlEntry(`${pad}-`, item, `${pad}  `));
  return Object.entries(v).flatMap(([k, item]) => {
    const key = /^[A-Za-z_][\w.-]*$/.test(k) && plainScalar(k) === k ? k : JSON.stringify(k);
    return yamlEntry(`${pad}${key}:`, item, `${pad}  `);
  });
}

/** Emits block-style YAML that `parseYaml` reads back to an equal value. */
function stringifyYaml(value) {
  if (!Array.isArray(value) && !isPlainObject(value)) return yamlScalar(value) + "\n";
  return yamlEntry("", value, "")
    .map((l, k) => (k === 0 ? l.trimStart() : l))
    .filter((l, k) => !(k === 0 && l === ""))
    .join("\n") + "\n";
}

module.exports = { parseYaml, stringifyYaml };
