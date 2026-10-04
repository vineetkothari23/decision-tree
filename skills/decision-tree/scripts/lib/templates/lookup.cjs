"use strict";

/** Finding and loading templates: project > $DTREE_TEMPLATES_PATH > user > built-in. */

const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATES_DIR, TEMPLATE_EXTS, TEMPLATE_NAME_RE, TEMPLATE_PATH_RE } = require("../constants.cjs");
const { builtinTemplatesDir, userTemplatesDir } = require("../paths.cjs");
const { DTError, isFile, realOrResolved } = require("../util.cjs");
const { parseYaml } = require("../yaml.cjs");
const { validateTemplate, validateTemplateName, countTemplateNodes } = require("./schema.cjs");

const templateNameOf = (file) => path.basename(file).replace(/\.(ya?ml|json)$/i, "");

function readTemplateFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new DTError(`cannot read template ${file}: ${e.code || e.message}`);
  }
  if (path.extname(file).toLowerCase() === ".json") {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new DTError(`${file}: invalid JSON: ${e.message}`);
    }
  }
  return parseYaml(text, file);
}

function loadTemplate(file, source = "path") {
  const name = templateNameOf(file);
  const tpl = validateTemplate(readTemplateFile(file), { label: `${JSON.stringify(name)} (${file})`, name });
  return { ...tpl, source, path: file };
}

/** Template directories in lookup order: project, $DTREE_TEMPLATES_PATH, user config, built-in. */
function templateDirs(store) {
  const dirs = [{ source: "project", dir: path.join(store.dir, TEMPLATES_DIR) }];
  for (const d of (process.env.DTREE_TEMPLATES_PATH || "").split(path.delimiter).filter(Boolean)) {
    dirs.push({ source: "user", dir: path.resolve(d) });
  }
  dirs.push({ source: "user", dir: userTemplatesDir() }, { source: "builtin", dir: builtinTemplatesDir() });
  const seen = new Set();
  return dirs.filter(({ dir }) => {
    const key = realOrResolved(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const templateFiles = (dir, name) => TEMPLATE_EXTS.map((ext) => path.join(dir, name + ext)).filter(isFile);

/** Finds a template by file path or name (project > user > built-in), without resolving `extends`. */
function findTemplate(store, arg, { allowPath = true } = {}) {
  if (TEMPLATE_PATH_RE.test(arg)) {
    if (!allowPath) throw new DTError(`template must be a name, not a path: ${JSON.stringify(arg)}`);
    const file = path.resolve(arg);
    if (!isFile(file)) throw new DTError(`template file ${arg} not found`);
    return loadTemplate(file, "path");
  }
  validateTemplateName(arg);
  const dirs = templateDirs(store);
  for (const { source, dir } of dirs) {
    const [file] = templateFiles(dir, arg);
    if (file) return loadTemplate(file, source);
  }
  throw new DTError(`template ${JSON.stringify(arg)} not found; run \`dtree templates\` to list them ` +
    `(searched ${dirs.map((d) => d.dir).join(", ")})`);
}

/** Every template found, in precedence order; `active` is false when an earlier directory shadows it. */
function listTemplates(store) {
  const rows = [];
  const winners = new Map();
  for (const { source, dir } of templateDirs(store)) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const names = [...new Set(files.filter((f) => TEMPLATE_PATH_RE.test(f)).map(templateNameOf))]
      .filter((n) => TEMPLATE_NAME_RE.test(n))
      .sort();
    for (const name of names) {
      const [file] = templateFiles(dir, name);
      if (!file) continue;
      const row = { name, title: name, description: "", extends: null, source, path: file, active: !winners.has(name), shadowed_by: null };
      if (!row.active) row.shadowed_by = winners.get(name);
      else winners.set(name, { source, path: file });
      try {
        const tpl = loadTemplate(file, source);
        row.title = tpl.title;
        row.description = tpl.description;
        row.extends = tpl.extends ?? (tpl.config ? "default" : null);
        row.nodes = countTemplateNodes(tpl.nodes);
      } catch (e) {
        if (!(e instanceof DTError)) throw e;
        row.error = e.message;
      }
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || Number(b.active) - Number(a.active));
}

module.exports = { templateNameOf, readTemplateFile, loadTemplate, templateDirs, templateFiles, findTemplate, listTemplates };
