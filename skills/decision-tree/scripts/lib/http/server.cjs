"use strict";

/** HTTP transport: request parsing, Host/Origin protection and JSON responses. */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { VIEWER_HTML } = require("../paths.cjs");
const { DTError } = require("../util.cjs");
const { api } = require("./api.cjs");

function send(res, code, body, ctype = "application/json") {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    "Content-Type": `${ctype}; charset=utf-8`,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function allowedHost(hostHeader, boundHost) {
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || net.isIP(bare) !== 0 || (Boolean(boundHost) && hostname === boundHost);
}

/** Blocks cross-site requests and DNS rebinding: Host must be localhost/an IP/the bound host, Origin must match Host. */
function forbidden(req, boundHost) {
  const host = req.headers.host || "";
  if (!allowedHost(host, boundHost)) return `host ${JSON.stringify(host)} not allowed`;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return `cross-origin request from ${origin} rejected`;
  return null;
}

function handle(app, req, raw, res, boundHost) {
  if (process.env.DTREE_VERBOSE) console.error(`${req.method} ${req.url}`);
  const denied = forbidden(req, boundHost);
  if (denied) return send(res, 403, { error: denied });
  try {
    const parts = new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "index.html"))) {
      return send(res, 200, fs.readFileSync(VIEWER_HTML), "text/html");
    }
    if (!parts.length || parts[0] !== "api") return send(res, 404, { error: "not found" });
    let body = {};
    if (["POST", "PATCH", "DELETE"].includes(req.method) && raw.length) body = JSON.parse(raw.toString("utf8"));
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new DTError("bad request: JSON body must be an object");
    }
    return send(res, 200, api(app, req.method, parts.slice(1), body));
  } catch (e) {
    if (e instanceof DTError) return send(res, 400, { error: e.message });
    if (e instanceof SyntaxError || e instanceof TypeError || e instanceof URIError) {
      return send(res, 400, { error: `bad request: ${e.message}` });
    }
    console.error(e);
    return send(res, 500, { error: "internal error" });
  }
}

function createServer(app, { host } = {}) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => handle(app, req, Buffer.concat(chunks), res, host));
  });
}

module.exports = { createServer };
