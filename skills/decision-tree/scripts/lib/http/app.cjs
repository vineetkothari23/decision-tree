"use strict";

/** The set of projects a viewer server exposes. */

const path = require("node:path");
const { DTError } = require("../util.cjs");
const { Store } = require("../store/store.cjs");
const { scanProjects } = require("../store/projects.cjs");

class App {
  constructor(projects, scanDirs = []) {
    this.fixed = projects.map((p) => path.resolve(p));
    this.scanDirs = scanDirs.map((d) => path.resolve(d));
  }

  stores() {
    const roots = [];
    for (const p of [...this.fixed, ...this.scanDirs.flatMap((d) => scanProjects(d))]) {
      if (!roots.includes(p)) roots.push(p);
    }
    return roots.map((r) => new Store(r));
  }

  store(pid) {
    const stores = this.stores();
    if (!/^\d+$/.test(pid) || Number(pid) >= stores.length) throw new DTError(`unknown project ${JSON.stringify(pid)}`);
    return stores[Number(pid)];
  }
}

module.exports = { App };
