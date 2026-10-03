"use strict";

/** Small shared helpers: the user-facing error type, timestamps, fs probes and value checks. */

const fs = require("node:fs");
const path = require("node:path");
const { SLUG_RE } = require("./constants.cjs");

class DTError extends Error {}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const realOrResolved = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function slugify(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "tree";
}

function validateSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new DTError(`invalid tree slug ${JSON.stringify(slug)}: use lowercase letters, digits, '.', '_', '-'`);
  }
  return slug;
}

function choice(value, allowed, what) {
  if (!allowed.includes(value)) {
    throw new DTError(`invalid ${what} ${JSON.stringify(value)}; expected one of: ${allowed.join(", ")}`);
  }
  return value;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return value.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(value)) throw new DTError("expected a list or a newline-separated string");
  return value.map((v) => String(v).trim()).filter(Boolean);
}

module.exports = { DTError, now, same, isDir, isFile, realOrResolved, sleep, isPlainObject, hasOwn, slugify, validateSlug, choice, asList };
