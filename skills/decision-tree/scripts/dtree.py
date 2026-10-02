#!/usr/bin/env python3
"""dtree: question-driven decision trees for planning software features.

Trees live as JSON files in <app>/.decisions/<tree-slug>.json. Agents use the
CLI; humans use the HTML viewer served by `dtree.py serve`. Standard library
only (Python 3.8+).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Iterator, Optional

SCHEMA_VERSION = 1
DECISIONS_DIR = ".decisions"
VIEWER_HTML = Path(__file__).resolve().parent / "viewer.html"
TOOL_DIR = "_tool"

NODE_TYPES = {"goal": "g", "question": "q", "option": "o", "decision": "d", "task": "t", "note": "n"}
KINDS = ["why", "what", "how", "where", "who", "when", "risk", "other"]
STATUSES = ["open", "exploring", "needs-input", "blocked", "decided", "chosen", "rejected", "deferred", "done"]
TREE_STATUSES = ["draft", "active", "decided", "implemented", "archived"]
LINK_TYPES = ["depends-on", "blocks", "relates-to", "supersedes", "duplicates"]
AUTHOR_TYPES = ["agent", "human"]
EDITABLE_NODE_FIELDS = ["title", "body", "kind", "status", "pros", "cons", "rationale", "assignee", "type"]
ACTIVITY_LIMIT = 500
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
CLOSED_STATUSES = {"decided", "chosen", "rejected", "deferred", "done"}


class DTError(Exception):
    pass


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:80] or "tree"


def validate_slug(slug: str) -> str:
    if not SLUG_RE.match(slug):
        raise DTError(f"invalid tree slug {slug!r}: use lowercase letters, digits, '.', '_', '-'")
    return slug


def choice(value: str, allowed: list, what: str) -> str:
    if value not in allowed:
        raise DTError(f"invalid {what} {value!r}; expected one of: {', '.join(allowed)}")
    return value


def as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, str):
        return [line.strip() for line in value.splitlines() if line.strip()]
    return [str(v).strip() for v in value if str(v).strip()]


# --------------------------------------------------------------------------- store


class Store:
    """One application's .decisions directory."""

    def __init__(self, project_root: Path):
        self.root = Path(project_root).resolve()
        self.dir = self.root / DECISIONS_DIR

    @property
    def name(self) -> str:
        return self.root.name

    def exists(self) -> bool:
        return self.dir.is_dir()

    def init(self, refresh_tool: bool = False) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        tool = self.dir / TOOL_DIR
        here = Path(__file__).resolve()
        if here.parent != tool.resolve() and (refresh_tool or not (tool / "dtree.py").exists()):
            tool.mkdir(exist_ok=True)
            shutil.copy2(here, tool / "dtree.py")
            shutil.copy2(VIEWER_HTML, tool / "viewer.html")
        readme = self.dir / "README.md"
        if not readme.exists():
            readme.write_text(
                "# Decisions\n\n"
                "Each `*.json` file here is a decision tree for one feature, created with the\n"
                "`decision-tree` skill (`dtree.py`). Nodes are goals, questions (why/what/how/where...),\n"
                "options, decisions, tasks and notes, each with a status and a comment thread.\n\n"
                "View, comment and coordinate in a browser (run from the app root):\n\n"
                "    python3 .decisions/_tool/dtree.py serve        # http://127.0.0.1:8765\n\n"
                "Agents: `python3 .decisions/_tool/dtree.py --help`.\n"
            )
        gitignore = self.dir / ".gitignore"
        if not gitignore.exists():
            gitignore.write_text(".lock\n*.tmp\n")

    def tree_path(self, slug: str) -> Path:
        return self.dir / f"{validate_slug(slug)}.json"

    def slugs(self) -> list:
        if not self.exists():
            return []
        return sorted(p.stem for p in self.dir.glob("*.json") if SLUG_RE.match(p.stem))

    def load(self, slug: str) -> dict:
        path = self.tree_path(slug)
        if not path.exists():
            raise DTError(f"tree {slug!r} not found in {self.dir}")
        with path.open() as f:
            return json.load(f)

    @contextlib.contextmanager
    def _lock(self) -> Iterator[None]:
        self.dir.mkdir(parents=True, exist_ok=True)
        with (self.dir / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _write(self, tree: dict) -> None:
        path = self.tree_path(tree["id"])
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(tree, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)

    @contextlib.contextmanager
    def edit(self, slug: str) -> Iterator[dict]:
        with self._lock():
            tree = self.load(slug)
            yield tree
            tree["revision"] = tree.get("revision", 0) + 1
            tree["updated_at"] = now()
            self._write(tree)

    def create_tree(self, slug: str, title: str, description: str, author: dict) -> dict:
        self.init()
        with self._lock():
            if self.tree_path(slug).exists():
                raise DTError(f"tree {slug!r} already exists")
            ts = now()
            tree = {
                "schema_version": SCHEMA_VERSION,
                "id": slug,
                "title": title,
                "description": description,
                "status": "draft",
                "created_at": ts,
                "updated_at": ts,
                "created_by": author,
                "revision": 1,
                "next_id": 1,
                "root_id": None,
                "nodes": {},
                "activity": [],
            }
            root = add_node(tree, None, "goal", title, description, None, "open", author)
            tree["root_id"] = root["id"]
            self._write(tree)
            return tree

    def summaries(self) -> list:
        out = []
        for slug in self.slugs():
            try:
                out.append(summarize(self.load(slug)))
            except (OSError, ValueError) as e:
                out.append({"id": slug, "title": slug, "error": str(e)})
        return out


def find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for p in [cur, *cur.parents]:
        if (p / DECISIONS_DIR).is_dir():
            return p
    here = Path(__file__).resolve().parent
    if here.name == TOOL_DIR and here.parent.name == DECISIONS_DIR:
        return here.parent.parent
    return cur


def scan_projects(base: Path, max_depth: int = 4) -> list:
    found = []
    base = base.resolve()
    skip = {"node_modules", ".git", "venv", ".venv", "__pycache__", "dist", "build", "target"}
    for dirpath, dirnames, _ in os.walk(base):
        depth = len(Path(dirpath).relative_to(base).parts)
        if DECISIONS_DIR in dirnames:
            found.append(Path(dirpath))
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".") and depth < max_depth]
    return found


# --------------------------------------------------------------------------- tree operations


def log(tree: dict, author: dict, action: str, node_id: Optional[str], detail: str = "") -> None:
    tree.setdefault("activity", []).append(
        {"at": now(), "by": author, "action": action, "node": node_id, "detail": detail}
    )
    del tree["activity"][:-ACTIVITY_LIMIT]


def get_node(tree: dict, nid: str) -> dict:
    node = tree["nodes"].get(nid)
    if node is None:
        raise DTError(f"node {nid!r} not found in tree {tree['id']!r}")
    return node


def children(tree: dict, nid: Optional[str]) -> list:
    return [n for n in tree["nodes"].values() if n.get("parent") == nid]


def descendants(tree: dict, nid: str) -> list:
    out, stack = [], [nid]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(c["id"] for c in children(tree, cur))
    return out


def add_node(tree, parent, ntype, title, body="", kind=None, status="open", author=None,
             pros=None, cons=None, assignee="") -> dict:
    choice(ntype, list(NODE_TYPES), "node type")
    choice(status, STATUSES, "status")
    if kind:
        choice(kind, KINDS, "kind")
    if parent is not None:
        get_node(tree, parent)
    elif tree["nodes"]:
        raise DTError("a parent node id is required (only the root goal has no parent)")
    if not title or not title.strip():
        raise DTError("title is required")
    nid = f"{NODE_TYPES[ntype]}{tree['next_id']}"
    tree["next_id"] += 1
    ts = now()
    node = {
        "id": nid,
        "type": ntype,
        "kind": kind if ntype == "question" else None,
        "title": title.strip(),
        "body": body or "",
        "status": status,
        "parent": parent,
        "pros": as_list(pros),
        "cons": as_list(cons),
        "rationale": "",
        "assignee": assignee or "",
        "chosen": None,
        "links": [],
        "comments": [],
        "history": [],
        "created_by": author,
        "created_at": ts,
        "updated_at": ts,
    }
    tree["nodes"][nid] = node
    log(tree, author, "add", nid, f"{ntype}: {node['title']}")
    return node


def update_node(tree: dict, nid: str, fields: dict, author: dict) -> dict:
    node = get_node(tree, nid)
    changed = []
    for key, value in fields.items():
        if value is None:
            continue
        if key not in EDITABLE_NODE_FIELDS:
            raise DTError(f"field {key!r} is not editable")
        if key == "status":
            choice(value, STATUSES, "status")
        elif key == "kind":
            value = value or None
            if value:
                choice(value, KINDS, "kind")
        elif key == "type":
            choice(value, list(NODE_TYPES), "node type")
        elif key in ("pros", "cons"):
            value = as_list(value)
        elif key == "title" and not str(value).strip():
            raise DTError("title cannot be empty")
        if node.get(key) != value:
            node["history"].append({"at": now(), "by": author, "field": key, "from": node.get(key), "to": value})
            node[key] = value
            changed.append(key)
    if changed:
        node["updated_at"] = now()
        detail = ", ".join(f"{k}={node[k]}" if k in ("status", "kind", "type") else k for k in changed)
        log(tree, author, "update", nid, detail)
    return node


def move_node(tree: dict, nid: str, new_parent: str, author: dict) -> dict:
    node = get_node(tree, nid)
    get_node(tree, new_parent)
    if nid == tree["root_id"]:
        raise DTError("cannot move the root goal")
    if new_parent in descendants(tree, nid):
        raise DTError("cannot move a node under its own descendant")
    node["parent"] = new_parent
    node["updated_at"] = now()
    log(tree, author, "move", nid, f"under {new_parent}")
    return node


def delete_node(tree: dict, nid: str, author: dict) -> list:
    get_node(tree, nid)
    if nid == tree["root_id"]:
        raise DTError("cannot delete the root goal; delete the tree file instead")
    removed = set(descendants(tree, nid))
    for rid in removed:
        del tree["nodes"][rid]
    for node in tree["nodes"].values():
        node["links"] = [lk for lk in node["links"] if lk["target"] not in removed]
        if node.get("chosen") in removed:
            node["chosen"] = None
    log(tree, author, "delete", nid, f"{len(removed)} node(s)")
    return sorted(removed)


def choose_option(tree: dict, oid: str, rationale: str, author: dict, reject_siblings: bool = True) -> dict:
    option = get_node(tree, oid)
    if option["type"] != "option":
        raise DTError(f"{oid} is a {option['type']}, not an option")
    update_node(tree, oid, {"status": "chosen", "rationale": rationale or option.get("rationale", "")}, author)
    parent = tree["nodes"].get(option["parent"])
    if reject_siblings and parent:
        for sib in children(tree, parent["id"]):
            if sib["type"] == "option" and sib["id"] != oid and sib["status"] not in ("rejected", "deferred"):
                update_node(tree, sib["id"], {"status": "rejected"}, author)
    if parent:
        parent["chosen"] = oid
        update_node(tree, parent["id"], {"status": "decided"}, author)
    log(tree, author, "choose", oid, rationale or "")
    return option


def add_comment(tree: dict, nid: str, text: str, author: dict, reply_to: Optional[str] = None) -> dict:
    node = get_node(tree, nid)
    if not text or not text.strip():
        raise DTError("comment text is required")
    if reply_to and not any(c["id"] == reply_to for c in node["comments"]):
        raise DTError(f"comment {reply_to!r} not found on {nid}")
    comment = {
        "id": f"c{tree['next_id']}",
        "author": author["name"],
        "author_type": author["type"],
        "text": text.strip(),
        "reply_to": reply_to,
        "resolved": False,
        "created_at": now(),
    }
    tree["next_id"] += 1
    node["comments"].append(comment)
    log(tree, author, "comment", nid, comment["text"][:120])
    return comment


def resolve_comment(tree: dict, nid: str, cid: str, resolved: bool, author: dict) -> dict:
    node = get_node(tree, nid)
    for c in node["comments"]:
        if c["id"] == cid:
            c["resolved"] = resolved
            log(tree, author, "resolve" if resolved else "reopen", nid, cid)
            return c
    raise DTError(f"comment {cid!r} not found on {nid}")


def add_link(tree: dict, src: str, dst: str, ltype: str, author: dict) -> dict:
    node = get_node(tree, src)
    get_node(tree, dst)
    choice(ltype, LINK_TYPES, "link type")
    if src == dst:
        raise DTError("cannot link a node to itself")
    link = {"target": dst, "type": ltype}
    if link not in node["links"]:
        node["links"].append(link)
        log(tree, author, "link", src, f"{ltype} {dst}")
    return link


def remove_link(tree: dict, src: str, dst: str, ltype: Optional[str], author: dict) -> None:
    node = get_node(tree, src)
    before = len(node["links"])
    node["links"] = [lk for lk in node["links"] if not (lk["target"] == dst and (ltype is None or lk["type"] == ltype))]
    if len(node["links"]) != before:
        log(tree, author, "unlink", src, dst)


def update_tree_meta(tree: dict, fields: dict, author: dict) -> dict:
    for key in ("title", "description", "status"):
        value = fields.get(key)
        if value is None:
            continue
        if key == "status":
            choice(value, TREE_STATUSES, "tree status")
        tree[key] = value
        if key in ("title", "description") and tree.get("root_id") in tree["nodes"]:
            tree["nodes"][tree["root_id"]]["title" if key == "title" else "body"] = value
        log(tree, author, "tree", None, f"{key}={value}" if key == "status" else key)
    return tree


def threads(node: dict) -> list:
    roots = [c for c in node["comments"] if not c.get("reply_to")]
    out = []
    for r in roots:
        msgs = [r] + [c for c in node["comments"] if c.get("reply_to") == r["id"]]
        out.append(msgs)
    return out


def inbox(tree: dict, audience: str) -> list:
    """Items waiting on `audience` ('agent' or 'human')."""
    other = "human" if audience == "agent" else "agent"
    items = []
    for node in tree["nodes"].values():
        for msgs in threads(node):
            if not msgs[0]["resolved"] and msgs[-1]["author_type"] == other:
                items.append({"node": node["id"], "title": node["title"], "kind": "comment",
                              "thread": msgs[0]["id"], "last": msgs[-1]})
        if audience == "human" and node["status"] == "needs-input":
            items.append({"node": node["id"], "title": node["title"], "kind": "needs-input"})
    return items


def review(tree: dict) -> list:
    """Gaps an agent should address to make the tree rigorous."""
    issues = []
    nodes = tree["nodes"]
    root = nodes.get(tree["root_id"])
    if root:
        kinds = {n.get("kind") for n in nodes.values() if n["type"] == "question"}
        missing = [k for k in ("why", "what", "how", "where") if k not in kinds]
        if missing:
            issues.append((root["id"], f"no {'/'.join(missing)} questions asked yet"))
    for n in nodes.values():
        kids = children(tree, n["id"])
        opts = [k for k in kids if k["type"] == "option"]
        if n["type"] == "question":
            if n["status"] not in ("decided", "deferred", "done", "rejected") and len(opts) < 2:
                issues.append((n["id"], f"open question has {len(opts)} option(s); propose at least 2"))
            if n["status"] == "decided" and not n.get("chosen") and not any(o["status"] == "chosen" for o in opts):
                issues.append((n["id"], "marked decided but no option is chosen"))
        if n["type"] == "option" and n["status"] not in ("rejected", "deferred"):
            if not n["pros"] or not n["cons"]:
                issues.append((n["id"], "option lacks pros and/or cons"))
            if n["status"] == "chosen" and not n.get("rationale"):
                issues.append((n["id"], "chosen option has no rationale"))
            if n["status"] == "chosen" and not any(k["type"] == "question" for k in kids):
                issues.append((n["id"], "chosen option has no follow-up questions (how/where/what next?)"))
        if n["type"] == "question" and n["status"] == "blocked" and not n["links"]:
            issues.append((n["id"], "blocked but no depends-on/blocks link explains why"))
    for item in inbox(tree, "agent"):
        issues.append((item["node"], f"unanswered human comment {item['thread']}: {item['last']['text'][:80]}"))
    return issues


def summarize(tree: dict) -> dict:
    nodes = tree["nodes"].values()
    by_status: dict = {}
    for n in nodes:
        by_status[n["status"]] = by_status.get(n["status"], 0) + 1
    open_q = sum(1 for n in nodes if n["type"] == "question" and n["status"] not in CLOSED_STATUSES)
    unresolved = sum(1 for n in nodes for t in threads(n) if not t[0]["resolved"])
    return {
        "id": tree["id"],
        "title": tree.get("title", tree["id"]),
        "status": tree.get("status", "draft"),
        "revision": tree.get("revision", 0),
        "updated_at": tree.get("updated_at"),
        "node_count": len(tree["nodes"]),
        "open_questions": open_q,
        "needs_input": by_status.get("needs-input", 0),
        "unresolved_threads": unresolved,
        "by_status": by_status,
        "waiting_on_agent": len(inbox(tree, "agent")),
        "waiting_on_human": len(inbox(tree, "human")),
    }


def render_text(tree: dict, show_body: bool = False) -> str:
    lines = []

    def label(n: dict) -> str:
        kind = f"{n['kind'].upper()}: " if n.get("kind") else ""
        marks = []
        if n["comments"]:
            open_threads = sum(1 for t in threads(n) if not t[0]["resolved"])
            marks.append(f"{len(n['comments'])} comment(s), {open_threads} open")
        if n["links"]:
            marks.append(", ".join(f"{lk['type']} {lk['target']}" for lk in n["links"]))
        if n.get("assignee"):
            marks.append(f"@{n['assignee']}")
        tail = f"  <{'; '.join(marks)}>" if marks else ""
        return f"[{n['id']}] {n['type']} {kind}{n['title']}  ({n['status']}){tail}"

    def walk(nid: str, prefix: str, last: bool, top: bool) -> None:
        n = tree["nodes"][nid]
        connector = "" if top else ("└── " if last else "├── ")
        lines.append(prefix + connector + label(n))
        child_prefix = prefix if top else prefix + ("    " if last else "│   ")
        if show_body:
            for text in ([n["body"]] if n["body"] else []) + ([f"rationale: {n['rationale']}"] if n.get("rationale") else []):
                for line in text.splitlines():
                    lines.append(child_prefix + "  │ " + line)
        kids = children(tree, nid)
        for i, k in enumerate(kids):
            walk(k["id"], child_prefix, i == len(kids) - 1, False)

    lines.append(f"# {tree['title']}  [{tree['id']}] ({tree.get('status', 'draft')}, rev {tree.get('revision', 0)})")
    if tree.get("root_id") in tree["nodes"]:
        walk(tree["root_id"], "", True, True)
    return "\n".join(lines)


def render_static_html(payload: dict) -> str:
    html = VIEWER_HTML.read_text()
    data = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    return html.replace("<!--DTREE_STATIC-->", f"<script>window.DTREE_STATIC = {data};</script>", 1)


# --------------------------------------------------------------------------- HTTP server


class App:
    def __init__(self, projects: list, scan_dirs: list):
        self.fixed = [Path(p).resolve() for p in projects]
        self.scan_dirs = [Path(d).resolve() for d in scan_dirs]

    def stores(self) -> list:
        roots: list = []
        for p in self.fixed + [p for d in self.scan_dirs for p in scan_projects(d)]:
            if p not in roots:
                roots.append(p)
        return [Store(r) for r in roots]

    def store(self, pid: str) -> Store:
        stores = self.stores()
        if not pid.isdigit() or int(pid) >= len(stores):
            raise DTError(f"unknown project {pid!r}")
        return stores[int(pid)]


def make_handler(app: App):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "dtree/1"

        def log_message(self, fmt, *args):
            if os.environ.get("DTREE_VERBOSE"):
                super().log_message(fmt, *args)

        def _send(self, code: int, body, ctype: str = "application/json") -> None:
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode())

        def _author(self, body: dict) -> dict:
            name = str(body.get("author") or "human").strip()[:80] or "human"
            atype = body.get("author_type") or "human"
            return {"name": name, "type": choice(atype, AUTHOR_TYPES, "author type")}

        def _route(self, method: str) -> None:
            path = urllib.parse.urlparse(self.path).path
            parts = [urllib.parse.unquote(p) for p in path.strip("/").split("/") if p]
            try:
                if method == "GET" and parts in ([], ["index.html"]):
                    return self._send(200, VIEWER_HTML.read_bytes(), "text/html")
                if not parts or parts[0] != "api":
                    return self._send(404, {"error": "not found"})
                result = self._api(method, parts[1:])
                return self._send(200, result)
            except DTError as e:
                return self._send(400, {"error": str(e)})
            except (ValueError, KeyError, TypeError) as e:
                return self._send(400, {"error": f"bad request: {e}"})

        def _api(self, method: str, p: list):
            if method == "GET" and p == ["meta"]:
                return {"node_types": list(NODE_TYPES), "kinds": KINDS, "statuses": STATUSES,
                        "tree_statuses": TREE_STATUSES, "link_types": LINK_TYPES}
            if method == "GET" and p == ["projects"]:
                return [{"id": str(i), "name": s.name, "path": str(s.root), "trees": s.summaries()}
                        for i, s in enumerate(app.stores())]
            if len(p) < 3 or p[0] != "projects" or p[2] != "trees":
                raise DTError("unknown endpoint")
            store = app.store(p[1])
            rest = p[3:]
            body = self._body() if method in ("POST", "PATCH", "DELETE") else {}
            if not rest and method == "POST":
                title = body.get("title") or ""
                if not title.strip():
                    raise DTError("title is required")
                slug = validate_slug(body.get("id") or slugify(title))
                tree = store.create_tree(slug, title.strip(), body.get("description", ""), self._author(body))
                return tree
            slug = rest[0]
            if len(rest) == 1 and method == "GET":
                return store.load(slug)
            author = self._author(body)
            with store.edit(slug) as tree:
                if len(rest) == 1 and method == "PATCH":
                    update_tree_meta(tree, body, author)
                    return tree
                if rest[1:] == ["nodes"] and method == "POST":
                    add_node(tree, body["parent"], body.get("type", "question"), body.get("title", ""),
                             body.get("body", ""), body.get("kind") or None, body.get("status", "open"),
                             author, body.get("pros"), body.get("cons"), body.get("assignee", ""))
                    return tree
                if len(rest) >= 3 and rest[1] == "nodes":
                    nid = rest[2]
                    tail = rest[3:]
                    if not tail and method == "PATCH":
                        if body.get("parent"):
                            move_node(tree, nid, body["parent"], author)
                        update_node(tree, nid, {k: body.get(k) for k in EDITABLE_NODE_FIELDS}, author)
                        return tree
                    if not tail and method == "DELETE":
                        delete_node(tree, nid, author)
                        return tree
                    if tail == ["choose"] and method == "POST":
                        choose_option(tree, nid, body.get("rationale", ""), author, body.get("reject_siblings", True))
                        return tree
                    if tail == ["comments"] and method == "POST":
                        add_comment(tree, nid, body.get("text", ""), author, body.get("reply_to"))
                        return tree
                    if len(tail) == 2 and tail[0] == "comments" and method == "PATCH":
                        resolve_comment(tree, nid, tail[1], bool(body.get("resolved", True)), author)
                        return tree
                    if tail == ["links"] and method == "POST":
                        add_link(tree, nid, body["target"], body.get("type", "relates-to"), author)
                        return tree
                    if tail == ["links"] and method == "DELETE":
                        remove_link(tree, nid, body["target"], body.get("type"), author)
                        return tree
                raise DTError("unknown endpoint")

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_PATCH(self):
            self._route("PATCH")

        def do_DELETE(self):
            self._route("DELETE")

    return Handler


# --------------------------------------------------------------------------- CLI


def cli_author(args) -> dict:
    name = args.author or os.environ.get("DTREE_AUTHOR") or ("agent" if args.as_type == "agent" else "human")
    return {"name": name, "type": args.as_type}


def out(args, data, text: str) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False) if args.json else text)


def main(argv: Optional[list] = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--project", "-C", default=argparse.SUPPRESS,
                        help="application root (default: nearest dir with .decisions, else cwd)")
    common.add_argument("--author", default=argparse.SUPPRESS, help="author name (default: $DTREE_AUTHOR or 'agent')")
    common.add_argument("--as", dest="as_type", choices=AUTHOR_TYPES, default=argparse.SUPPRESS,
                        help="author type (default: $DTREE_AUTHOR_TYPE or agent)")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS, help="machine-readable output")
    ap = argparse.ArgumentParser(prog="dtree", description="Question-driven decision trees stored in .decisions/",
                                 parents=[common])
    sub = ap.add_subparsers(dest="cmd", required=True)
    add_parser = sub.add_parser
    sub.add_parser = lambda *a, **k: add_parser(*a, parents=[common], **k)

    p = sub.add_parser("init", help="create .decisions/ (and vendor the tool into .decisions/_tool/)")
    p.add_argument("--refresh-tool", action="store_true", help="overwrite .decisions/_tool with this version")
    sub.add_parser("list", help="list trees in the project")

    p = sub.add_parser("new", help="create a tree for a feature")
    p.add_argument("title")
    p.add_argument("--id", help="tree slug (default: from title)")
    p.add_argument("--description", "-d", default="")

    p = sub.add_parser("show", help="print a tree")
    p.add_argument("tree")
    p.add_argument("--body", action="store_true", help="include node bodies and rationale")

    p = sub.add_parser("node", help="print one node with comments and history")
    p.add_argument("tree")
    p.add_argument("node")

    p = sub.add_parser("add", help="add a node under a parent")
    p.add_argument("tree")
    p.add_argument("--parent", "-p", required=True)
    p.add_argument("--type", "-t", choices=list(NODE_TYPES), default="question")
    p.add_argument("--kind", "-k", choices=KINDS)
    p.add_argument("--title", required=True)
    p.add_argument("--body", "-b", default="")
    p.add_argument("--status", "-s", choices=STATUSES, default="open")
    p.add_argument("--pro", action="append", dest="pros", help="repeatable")
    p.add_argument("--con", action="append", dest="cons", help="repeatable")
    p.add_argument("--assignee", default="")

    p = sub.add_parser("update", help="edit node fields")
    p.add_argument("tree")
    p.add_argument("node")
    p.add_argument("--title")
    p.add_argument("--body", "-b")
    p.add_argument("--kind", "-k", choices=KINDS)
    p.add_argument("--type", "-t", choices=list(NODE_TYPES))
    p.add_argument("--status", "-s", choices=STATUSES)
    p.add_argument("--pro", action="append", dest="pros", help="replaces pros; repeatable")
    p.add_argument("--con", action="append", dest="cons", help="replaces cons; repeatable")
    p.add_argument("--rationale", "-r")
    p.add_argument("--assignee")
    p.add_argument("--parent", help="move node under another parent")

    p = sub.add_parser("status", help="set node status")
    p.add_argument("tree")
    p.add_argument("node")
    p.add_argument("status", choices=STATUSES)

    p = sub.add_parser("choose", help="mark an option chosen; reject sibling options; mark question decided")
    p.add_argument("tree")
    p.add_argument("option")
    p.add_argument("--rationale", "-r", default="")
    p.add_argument("--keep-siblings", action="store_true", help="do not reject sibling options")

    p = sub.add_parser("comment", help="comment on a node or reply to a comment")
    p.add_argument("tree")
    p.add_argument("node")
    p.add_argument("text")
    p.add_argument("--reply-to", help="comment id to reply to")

    p = sub.add_parser("resolve", help="resolve (or --reopen) a comment thread")
    p.add_argument("tree")
    p.add_argument("node")
    p.add_argument("comment")
    p.add_argument("--reopen", action="store_true")

    p = sub.add_parser("link", help="link two nodes (graph edge)")
    p.add_argument("tree")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--type", choices=LINK_TYPES, default="depends-on")

    p = sub.add_parser("unlink", help="remove a link")
    p.add_argument("tree")
    p.add_argument("src")
    p.add_argument("dst")

    p = sub.add_parser("delete", help="delete a node and its subtree")
    p.add_argument("tree")
    p.add_argument("node")

    p = sub.add_parser("set-tree", help="edit tree title/description/status")
    p.add_argument("tree")
    p.add_argument("--title")
    p.add_argument("--description", "-d")
    p.add_argument("--status", choices=TREE_STATUSES)

    p = sub.add_parser("inbox", help="items waiting on agents (default) or humans")
    p.add_argument("tree", nargs="?", help="default: all trees")
    p.add_argument("--for", dest="audience", choices=AUTHOR_TYPES, default="agent")

    p = sub.add_parser("review", help="list gaps: unasked why/what/how/where, <2 options, missing pros/cons...")
    p.add_argument("tree")

    p = sub.add_parser("serve", help="serve the HTML viewer + JSON API")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--scan", action="append", default=[], help="also discover every */.decisions under DIR (repeatable)")
    p.add_argument("--extra-project", action="append", default=[], dest="extra", help="additional app roots")

    p = sub.add_parser("render", help="write a self-contained read-only HTML snapshot")
    p.add_argument("--out", "-o", required=True)
    p.add_argument("--tree", help="only this tree (default: all trees in the project)")

    ap.set_defaults(project=None, author=None, json=False, as_type=os.environ.get("DTREE_AUTHOR_TYPE", "agent"))
    args = ap.parse_args(argv)
    root = Path(args.project).resolve() if args.project else find_project_root(Path.cwd())
    store = Store(root)
    author = cli_author(args)

    try:
        return run(args, store, author)
    except DTError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def run(args, store: Store, author: dict) -> int:
    cmd = args.cmd
    if cmd == "init":
        store.init(args.refresh_tool)
        out(args, {"dir": str(store.dir)}, f"initialized {store.dir} (tool: {store.dir / TOOL_DIR / 'dtree.py'})")
    elif cmd == "list":
        rows = store.summaries()
        text = "\n".join(
            f"{s['id']:<32} {s.get('status', ''):<12} nodes={s.get('node_count', 0):<4} open_q={s.get('open_questions', 0):<3} "
            f"needs_input={s.get('needs_input', 0):<3} waiting_on_agent={s.get('waiting_on_agent', 0)}  {s['title']}"
            for s in rows) or f"no trees in {store.dir}"
        out(args, rows, text)
    elif cmd == "new":
        tree = store.create_tree(validate_slug(args.id or slugify(args.title)), args.title, args.description, author)
        out(args, tree, f"created tree {tree['id']} with root goal {tree['root_id']} at {store.tree_path(tree['id'])}")
    elif cmd == "show":
        tree = store.load(args.tree)
        out(args, tree, render_text(tree, args.body))
    elif cmd == "node":
        node = get_node(store.load(args.tree), args.node)
        lines = [f"[{node['id']}] {node['type']} {node.get('kind') or ''} ({node['status']}) parent={node['parent']}",
                 node["title"]]
        if node["body"]:
            lines += ["", node["body"]]
        for key in ("pros", "cons"):
            if node[key]:
                lines += [f"{key}:"] + [f"  - {x}" for x in node[key]]
        if node.get("rationale"):
            lines.append(f"rationale: {node['rationale']}")
        if node["links"]:
            lines.append("links: " + ", ".join(f"{lk['type']} {lk['target']}" for lk in node["links"]))
        for msgs in threads(node):
            lines.append("")
            for i, c in enumerate(msgs):
                state = " [resolved]" if i == 0 and c["resolved"] else ""
                lines.append(f"{'    ' if i else ''}{c['id']} {c['author']} ({c['author_type']}) {c['created_at']}{state}: {c['text']}")
        out(args, node, "\n".join(lines))
    elif cmd in ("add", "update", "status", "choose", "comment", "resolve", "link", "unlink", "delete", "set-tree"):
        with store.edit(args.tree) as tree:
            if cmd == "add":
                res = add_node(tree, args.parent, args.type, args.title, args.body, args.kind, args.status,
                               author, args.pros, args.cons, args.assignee)
                msg = f"added {res['id']}"
            elif cmd == "update":
                if args.parent:
                    move_node(tree, args.node, args.parent, author)
                res = update_node(tree, args.node, {
                    "title": args.title, "body": args.body, "kind": args.kind, "type": args.type,
                    "status": args.status, "pros": args.pros, "cons": args.cons,
                    "rationale": args.rationale, "assignee": args.assignee}, author)
                msg = f"updated {res['id']}"
            elif cmd == "status":
                res = update_node(tree, args.node, {"status": args.status}, author)
                msg = f"{res['id']} -> {args.status}"
            elif cmd == "choose":
                res = choose_option(tree, args.option, args.rationale, author, not args.keep_siblings)
                msg = f"chose {res['id']} for {res['parent']}"
            elif cmd == "comment":
                res = add_comment(tree, args.node, args.text, author, args.reply_to)
                msg = f"added comment {res['id']} on {args.node}"
            elif cmd == "resolve":
                res = resolve_comment(tree, args.node, args.comment, not args.reopen, author)
                msg = f"{'reopened' if args.reopen else 'resolved'} {args.comment}"
            elif cmd == "link":
                res = add_link(tree, args.src, args.dst, args.type, author)
                msg = f"linked {args.src} {args.type} {args.dst}"
            elif cmd == "unlink":
                remove_link(tree, args.src, args.dst, None, author)
                res, msg = {}, f"unlinked {args.src} -> {args.dst}"
            elif cmd == "delete":
                res = {"removed": delete_node(tree, args.node, author)}
                msg = f"deleted {', '.join(res['removed'])}"
            else:
                res = update_tree_meta(tree, {"title": args.title, "description": args.description,
                                              "status": args.status}, author)
                res = summarize(res)
                msg = f"updated tree {args.tree}"
        out(args, res, msg)
    elif cmd == "inbox":
        slugs = [args.tree] if args.tree else store.slugs()
        items = []
        for slug in slugs:
            for item in inbox(store.load(slug), args.audience):
                items.append({"tree": slug, **item})
        lines = []
        for it in items:
            if it["kind"] == "comment":
                last = it["last"]
                lines.append(f"{it['tree']} {it['node']} thread {it['thread']} — {last['author']} ({last['author_type']}): {last['text']}")
            else:
                lines.append(f"{it['tree']} {it['node']} needs-input — {it['title']}")
        out(args, items, "\n".join(lines) or f"nothing waiting on {args.audience}s")
    elif cmd == "review":
        issues = review(store.load(args.tree))
        out(args, [{"node": n, "issue": i} for n, i in issues],
            "\n".join(f"{n}: {i}" for n, i in issues) or "no gaps found")
    elif cmd == "serve":
        extras = [Path(p) for p in args.extra]
        if not args.scan and not store.exists():
            store.init()
        app = App(([store.root] if store.exists() else []) + extras, args.scan)
        server = http.server.ThreadingHTTPServer((args.host, args.port), make_handler(app))
        print(f"dtree viewer on http://{args.host}:{args.port}  projects: "
              + ", ".join(str(s.root) for s in app.stores()), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    elif cmd == "render":
        slugs = [args.tree] if args.tree else store.slugs()
        payload = {"projects": [{"id": "0", "name": store.name, "path": str(store.root),
                                 "trees": [summarize(store.load(s)) for s in slugs]}],
                   "trees": {f"0/{s}": store.load(s) for s in slugs},
                   "meta": {"node_types": list(NODE_TYPES), "kinds": KINDS, "statuses": STATUSES,
                            "tree_statuses": TREE_STATUSES, "link_types": LINK_TYPES},
                   "generated_at": now()}
        Path(args.out).write_text(render_static_html(payload))
        out(args, {"out": args.out}, f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
