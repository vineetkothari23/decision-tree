"use strict";

/** Saving and removing project/user modes (named templates). */

const fs = require("node:fs");
const path = require("node:path");
const { TEMPLATES_DIR } = require("../constants.cjs");
const { userTemplatesDir } = require("../paths.cjs");
const { DTError, isFile, isPlainObject, same } = require("../util.cjs");
const { parseYaml, stringifyYaml } = require("../yaml.cjs");
const { validateTemplate, validateTemplateName, countTemplateNodes } = require("./schema.cjs");
const { readTemplateFile, templateFiles, listTemplates } = require("./lookup.cjs");
const { treeToTemplate } = require("./export.cjs");

function modeDir(store, user) {
  return user ? { source: "user", dir: userTemplatesDir() } : { source: "project", dir: path.join(store.dir, TEMPLATES_DIR) };
}

/** Validates a YAML/JSON template file and saves it as `<name>.yaml` in the project (or user) template dir. */
function createMode(store, name, file, { user = false, force = false } = {}) {
  validateTemplateName(name);
  const src = path.resolve(file);
  if (!isFile(src)) throw new DTError(`template file ${file} not found`);
  const data = readTemplateFile(src);
  if (isPlainObject(data)) data.name = name;
  const label = `${JSON.stringify(name)} (${src})`;
  validateTemplate(data, { label, name });
  let text = null;
  if (!/\.json$/i.test(src)) {
    const raw = fs.readFileSync(src, "utf8").replace(/^\uFEFF/, "");
    const renamed = /^name:.*$/m.test(raw) ? raw.replace(/^name:.*$/m, `name: ${name}`) : null;
    try {
      if (renamed !== null && same(parseYaml(renamed, src), data)) text = renamed;
    } catch (e) {
      if (!(e instanceof DTError)) throw e;
    }
  }
  if (text === null) text = stringifyYaml(data);
  validateTemplate(parseYaml(text, src), { label, name });
  return writeMode(store, name, text, { user, force });
}

/** Saves a tree's structure (see treeToTemplate) as the project mode `<name>`. */
function saveTreeAsMode(store, tree, name, { force = false } = {}) {
  const text = stringifyYaml(treeToTemplate(tree, name));
  const tpl = validateTemplate(parseYaml(text, `${name}.yaml`), { label: JSON.stringify(name), name });
  return { ...writeMode(store, name, text, { force }), nodes: countTemplateNodes(tpl.nodes) };
}

function writeMode(store, name, text, { user = false, force = false } = {}) {
  const { source, dir } = modeDir(store, user);
  const dest = path.join(dir, `${name}.yaml`);
  const existing = templateFiles(dir, name);
  if (existing.length && !force) {
    throw new DTError(`${source} mode ${JSON.stringify(name)} already exists at ${existing[0]}; pass --force to overwrite`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text.endsWith("\n") ? text : text + "\n");
  fs.renameSync(tmp, dest);
  for (const f of existing) if (f !== dest) fs.rmSync(f, { force: true });
  const shadowed = listTemplates(store).find((r) => r.name === name && r.path !== dest && !r.active);
  return { name, source, path: dest, shadows: shadowed ? { source: shadowed.source, path: shadowed.path } : null };
}

/** Deletes a project (or user) template; built-in templates can never be removed. */
function removeMode(store, name, { user = false } = {}) {
  validateTemplateName(name);
  const { source, dir } = modeDir(store, user);
  const files = templateFiles(dir, name);
  if (!files.length) {
    const other = listTemplates(store).find((r) => r.name === name);
    if (other && other.source === "builtin") {
      throw new DTError(`${JSON.stringify(name)} is a built-in template and cannot be removed ` +
        `(shadow it with \`dtree create-mode ${name} --yaml <file>\` instead)`);
    }
    if (other) {
      const hint = other.source === "project" ? " (omit --user)" : other.path.startsWith(userTemplatesDir()) ? " (pass --user)" : "";
      throw new DTError(`no ${source} mode ${JSON.stringify(name)} in ${dir}; it is a ${other.source} template at ${other.path}${hint}`);
    }
    throw new DTError(`mode ${JSON.stringify(name)} not found in ${dir}; run \`dtree modes\` to list them`);
  }
  for (const f of files) fs.rmSync(f, { force: true });
  const next = listTemplates(store).find((r) => r.name === name && r.active);
  return { name, source, removed: files, now_active: next ? { source: next.source, path: next.path } : null };
}

module.exports = { createMode, saveTreeAsMode, removeMode };
