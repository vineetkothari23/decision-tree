"use strict";

/** Mode drafts: work-in-progress modes stored as ordinary trees under .decisions/_drafts/, edited like any tree. */

const fs = require("node:fs");
const path = require("node:path");
const { DECISIONS_DIR, DRAFTS_DIR } = require("../constants.cjs");
const { Store } = require("./store.cjs");

class DraftStore extends Store {
  constructor(projectRoot) {
    super(projectRoot);
    this.dir = path.join(this.root, DECISIONS_DIR, DRAFTS_DIR);
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  remove(slug) {
    const file = this.treePath(slug);
    this.withLock(() => fs.rmSync(file, { force: true }));
  }
}

module.exports = { DraftStore };
