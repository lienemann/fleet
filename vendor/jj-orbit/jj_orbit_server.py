#!/usr/bin/env python3
"""Serve jj-orbit for a live jj repository: re-exports after every jj operation and pushes updates to the browser."""

import argparse
import gzip
import json
import subprocess
import os
import re
import shlex
import sys
import tempfile
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jj_export  # noqa: E402

VERSION = "0.32.2"
if getattr(jj_export, "VERSION", "old") != VERSION:
    sys.exit(f"version mismatch: server {VERSION}, exporter {getattr(jj_export, 'VERSION', 'old')} "
             f"({jj_export.__file__}); replace all three files from the same bundle")
VERSION_RE = re.compile(r'<meta name="jj-orbit-version" content="([^"]+)"')
DEMO_RE = re.compile(r'(<script type="application/json" id="demo-data">)(.*?)(</script>)', re.S)


def op_heads_dir(repo):
    """The directory jj rewrites on every operation; its file names are the current op ids."""
    root = Path(jj_export.jj(repo, "workspace", "root").strip())
    store = root / ".jj" / "repo"
    if store.is_file():
        target = Path(store.read_text().strip())
        store = target if target.is_absolute() else (store.parent / target).resolve()
    heads = store / "op_heads" / "heads"
    if not heads.is_dir():
        raise jj_export.JJError(f"op heads not found at {heads}")
    return heads


class Live:
    def __init__(self, args):
        self.args = args
        self.repo = args.repository
        self.cache = {}
        self.export_lock = threading.Lock()
        self.cond = threading.Condition()
        self.version = 0
        self.graph_no = 0
        self.log = deque(maxlen=200)
        self.body = b"{}"
        self.body_gz = gzip.compress(self.body)
        self.op = None
        self.busy = False
        self.error = None
        self.ms = 0
        self.heads_dir = op_heads_dir(self.repo)
        self.lazy = {}
        self.lazy_lock = threading.Lock()
        self.action_lock = threading.Lock()
        self.activity = deque(maxlen=100)
        self.act_seq = 0
        self.tool_dir = tempfile.mkdtemp(prefix="jj-orbit-")
        self.tool = os.path.join(self.tool_dir, "orbit_lines_tool.py")
        with open(self.tool, "w", encoding="utf-8") as f:
            f.write(LINES_TOOL)
        self.merge_tool = os.path.join(self.tool_dir, "orbit_merge_tool.py")
        with open(self.merge_tool, "w", encoding="utf-8") as f:
            f.write(MERGE_TOOL)
        self.seen = None

    def heads(self):
        try:
            return frozenset(os.listdir(self.heads_dir))
        except OSError:
            return None

    def publish(self, event, payload):
        with self.cond:
            self.version += 1
            self.log.append((self.version, event, payload))
            self.cond.notify_all()

    def delete_untracked(self, request):
        """Deletes files jj reports as untracked in this workspace. Only those: anything else is refused."""
        paths = request.get("paths")
        if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
            raise ActionError("paths required")
        repo = str(Path(self.repo or ".").resolve())
        root = Path(jj_export.workspace_root(repo)).resolve()
        allowed = set(jj_export.untracked_paths(repo))
        bad = [p for p in paths if p not in allowed]
        if bad:
            raise ActionError("not untracked: " + ", ".join(bad[:5]))
        command = "delete " + " ".join(shlex.quote(p) for p in paths)
        if request.get("stage") == "plan":
            return {"command": command}
        if request.get("stage") != "run":
            raise ActionError("untracked-delete has no preview")
        for p in paths:
            target = (root / p).resolve()
            if root not in target.parents:
                raise ActionError(f"outside the workspace: {p}")
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        self.act_seq += 1
        self.activity.appendleft({"id": self.act_seq, "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "command": command, "ok": True, "code": 0, "ms": 0, "output": ""})
        self.export(snapshot=True)
        return {"command": command, "ok": True, "op": None, "op_desc": "deleted untracked files", "output": "", "activity": self.act_seq}

    def export(self, snapshot):
        with self.export_lock:
            heads_before = self.heads()
            self.busy = True
            self.publish("busy", {"busy": True})
            t0 = time.monotonic()
            try:
                data = jj_export.export(
                    self.repo, self.args.revisions, self.args.window, self.args.ops,
                    self.args.evolog == "eager", snapshot, self.cache,
                    jobs=self.args.jobs, evolog_depth=self.args.evolog_depth, evolog_budget=self.args.evolog_budget,
                )
            except jj_export.JJError as e:
                self.error = str(e)
                self.busy = False
                self.publish("fail", {"message": self.error})
                log(f"export failed: {self.error}")
                return False
            self.ms = int((time.monotonic() - t0) * 1000)
            self.error = None
            data["meta"]["repo"] = str(Path(self.repo or ".").resolve())
            data["meta"]["evolog"] = self.args.evolog
            body = json.dumps(data, separators=(",", ":")).encode()
            self.body, self.body_gz = body, gzip.compress(body, 5)
            self.op = data["meta"]["op"]
            self.seen = self.heads() if snapshot else heads_before
            self.busy = False
            self.graph_no += 1
            self.publish("graph", {"graph": self.graph_no, "op": self.op, "ms": self.ms, "commits": len(data["commits"])})
            log(f"op {self.op}: {len(data['commits'])} commits, {len(data['ops'])} ops in {self.ms} ms")
            if self.args.profile:
                print(jj_export.profile_report(self.ms / 1000), file=sys.stderr, flush=True)
            return True

    def action(self, request):
        """stage plan: only the command; preview: run without integrating and export that state;
        run: execute, then re-export."""
        if request.get("op") == "untracked-delete":
            return self.delete_untracked(request)
        argv = build_action(request)
        if request.get("ignore_immutable") is True:
            argv = ["--ignore-immutable", *argv]
        repo = str(Path(self.repo or ".").resolve())
        tool_cfg = []
        if request.get("op") == "resolve":
            table = request.get("contents") or ({request.get("path"): request.get("content")} if request.get("path") else None)
            if not isinstance(table, dict) or not table or not all(isinstance(k, str) and isinstance(v, str) for k, v in table.items()):
                raise ActionError("resolve: contents {path: text} required")
            fd, res_path = tempfile.mkstemp(suffix=".json", dir=self.tool_dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(table, f)
            tool_cfg = ["--config", f"merge-tools.orbit-merge.program={json.dumps(sys.executable)}",
                        "--config", "merge-tools.orbit-merge.merge-args=" + json.dumps([self.merge_tool, "$output", "$path", res_path]),
                        "--config", "merge-tools.orbit-merge.merge-tool-edits-conflict-markers=false"]
        if request.get("selection") is not None:
            if request.get("op") not in LINE_OPS:
                raise ActionError("line selection only for split, squash and restore")
            sel = request["selection"]
            if not isinstance(sel, dict) or not isinstance(sel.get("files"), dict):
                raise ActionError("selection: expected {files: {...}}")
            sel = {"reverse": request.get("op") == "restore", "files": sel["files"]}
            fd, sel_path = tempfile.mkstemp(suffix=".json", dir=self.tool_dir)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(sel, f)
            argv = [x for x in argv if not x.startswith("root-file:") and x != "--"] + ["--tool", "orbit-lines"]
            tool_cfg = ["--config", f"merge-tools.orbit-lines.program={json.dumps(sys.executable)}",
                        "--config", "merge-tools.orbit-lines.edit-args=" + json.dumps([self.tool, "$left", "$right", sel_path]),
                        "--config", "ui.diff-instructions=false"]
        if any("{WORKSPACE_DIR}" in x for x in argv):
            parent = str(Path(jj_export.workspace_root(repo)).parent)
            argv = [x.replace("{WORKSPACE_DIR}", parent) for x in argv]
            if Path(argv[-1]).exists():
                raise ActionError(f"{argv[-1]} exists already")
        command = shlex.join(["jj", *argv])
        mode = request.get("stage", "plan")
        if mode == "plan":
            return {"command": command}
        if mode == "preview" and request.get("op") == "git-push":
            code, out, err = run_jj(repo, argv + ["--dry-run"])
            return {"command": command + " --dry-run", "ok": code == 0, "output": (err + out).strip(),
                    "error": (err or out).strip() if code else None}
        if mode == "preview":
            if request.get("op") in NETWORK or request.get("op") in ("undo", "undo-last", "redo", "workspace-add", "workspace-remove", "workspace-snapshot", "workspace-update-stale", "untracked-delete",
                                                                  "git-remote-add", "git-remote-rename", "git-remote-remove", "op-abandon", "file-untrack", "file-chmod"):
                raise ActionError("no preview for this action")
            with self.export_lock:
                code, out, err = run_jj(repo, argv, ["--ignore-working-copy", "--no-integrate-operation", *tool_cfg])
                if code != 0:
                    return {"command": command, "ok": False, "error": (err or out).strip()}
                m = re.search(r"requested: ([0-9a-f]+)", err + out)
                if not m:
                    return {"command": command, "ok": True, "noop": True, "output": (err + out).strip() or "Nothing to do."}
                data = jj_export.export(jj_export.RepoAt(repo, m.group(1)), self.args.revisions, self.args.window, 0,
                                        False, False, {}, jobs=self.args.jobs)
            data["meta"]["repo"] = repo
            data["meta"]["evolog"] = self.args.evolog
            data["meta"]["preview"] = {"op": m.group(1), "command": command}
            return {"command": command, "ok": True, "graph": data, "output": (err + out).strip()}
        if mode != "run":
            raise ActionError("stage must be plan, preview or run")
        target_repo = repo
        if argv and argv[-1].startswith("{IN_WORKSPACE}"):
            name = argv[-1][len("{IN_WORKSPACE}"):]
            root = next((w["root"] for w in jj_export.workspaces(repo) if w["name"] == name), None)
            if not root or not Path(root).is_dir():
                raise ActionError(f"workspace {name!r} has no directory on disk")
            argv, target_repo = argv[:-1], root
            command = shlex.join(["jj", "-R", root, *argv])
        with self.action_lock:
            try:
                jj_export.log_commits(repo, "present(@)", snapshot=True, tag="snapshot working copy")
            except jj_export.JJError as e:
                if "working copy is stale" not in str(e):
                    raise
            before = jj_export.current_op(repo)
            t0 = time.monotonic()
            code, out, err = run_jj(target_repo, argv, tool_cfg)
            ms = int((time.monotonic() - t0) * 1000)
            after = jj_export.current_op(repo)
        log(f"action: {command} -> {'ok' if code == 0 else 'failed'}")
        self.act_seq += 1
        entry = {"id": self.act_seq, "time": time.strftime("%Y-%m-%dT%H:%M:%S"), "command": command, "ok": code == 0,
                 "code": code, "ms": ms, "output": (err + out).strip()[-20000:]}
        if code != 0:
            self.activity.appendleft(entry)
            return {"command": command, "ok": False, "error": (err or out).strip(), "activity": self.act_seq}
        desc = jj_export.jj(repo, "op", "log", "--no-graph", "--limit", "1", "-T", "description").strip()
        entry.update(op=after if after != before else None, op_desc=desc)
        self.activity.appendleft(entry)
        self.export(snapshot=False)
        return {"command": command, "ok": True, "op": after if after != before else None, "op_desc": desc,
                "output": (err + out).strip(), "activity": self.act_seq}

    def evolog(self, commit_id):
        """One commit's earlier versions, read on demand; a commit's evolog never changes."""
        with self.lazy_lock:
            hit = self.lazy.get(commit_id)
        if hit is not None:
            return hit
        warnings = []
        entries = jj_export.evolog_single(self.repo, commit_id, warnings, self.args.evolog_depth)
        hit = {"id": commit_id, "entries": [e for e in entries if e["id"] != commit_id], "warnings": warnings}
        with self.lazy_lock:
            self.lazy[commit_id] = hit
        return hit

    def watch(self):
        while True:
            time.sleep(self.args.interval)
            h = self.heads()
            if h is None or h == self.seen:
                continue
            time.sleep(self.args.debounce)
            if self.heads() != h:
                continue
            self.export(snapshot=False)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


LINES_TOOL = '"""Diff-editor helper for jj orbit: applies a line selection made in the viewer.\n\njj calls it with two directories (left, right) and expects the right one to be edited. The selection file names,\nper file, which difflib blocks and lines of the parent->commit change to apply; everything else stays as in the\nparent. With "reverse" (jj restore), left holds the commit and right the parent, and the selection names the\nchanges to drop."""\nimport difflib\nimport hashlib\nimport json\nimport os\nimport shutil\nimport sys\n\n\ndef read(path):\n    try:\n        with open(path, "rb") as f:\n            return f.read()\n    except FileNotFoundError:\n        return None\n\n\ndef lines(data):\n    return data.decode("utf-8", errors="surrogateescape").splitlines(keepends=True)\n\n\ndef main():\n    left, right, sel_path = sys.argv[1:4]\n    sel = json.load(open(sel_path, encoding="utf-8"))\n    reverse = sel.get("reverse", False)\n    chosen = sel.get("files", {})\n    paths = set()\n    for root in (left, right):\n        for dp, _, fns in os.walk(root):\n            for fn in fns:\n                rel = os.path.relpath(os.path.join(dp, fn), root)\n                if rel != "JJ-INSTRUCTIONS":\n                    paths.add(rel.replace(os.sep, "/"))\n    parent_dir, commit_dir = (right, left) if reverse else (left, right)\n    for rel in sorted(paths):\n        pa, pb = os.path.join(parent_dir, rel), os.path.join(commit_dir, rel)\n        a, b = read(pa), read(pb)\n        if a == b:\n            continue\n        spec = chosen.get(rel)\n        if spec is not None:\n            if hashlib.sha1(a or b"").hexdigest() != spec.get("sha_a") or hashlib.sha1(b or b"").hexdigest() != spec.get("sha_b"):\n                sys.exit(f"orbit: {rel} changed since the selection was made; reload and select again")\n        if spec is None:\n            apply_all = reverse\n            result = b if apply_all else a\n        elif spec.get("whole"):\n            result = a if reverse else b\n        else:\n            keep = {tuple(x) for x in spec.get("keep", [])}\n            al, bl = lines(a or b""), lines(b or b"")\n            out = []\n            for idx, (tag, i1, i2, j1, j2) in enumerate(difflib.SequenceMatcher(None, al, bl, autojunk=False).get_opcodes()):\n                if tag == "equal":\n                    out.extend(al[i1:i2])\n                    continue\n                for off, line in enumerate(al[i1:i2]):\n                    applied = ((idx, "d", off) in keep) != reverse\n                    if not applied:\n                        out.append(line)\n                for off, line in enumerate(bl[j1:j2]):\n                    applied = ((idx, "a", off) in keep) != reverse\n                    if applied:\n                        out.append(line)\n            result = None if not out and (a is None or b is None) else "".join(out).encode("utf-8", errors="surrogateescape")\n        target = os.path.join(right, rel)\n        if result is None:\n            if os.path.exists(target):\n                os.remove(target)\n            continue\n        os.makedirs(os.path.dirname(target), exist_ok=True)\n        src_mode = pb if os.path.exists(pb) else pa\n        with open(target, "wb") as f:\n            f.write(result)\n        if os.path.exists(src_mode) and os.path.abspath(src_mode) != os.path.abspath(target):\n            shutil.copymode(src_mode, target)\n\n\nif __name__ == "__main__":\n    main()\n'
MERGE_TOOL = '"""Merge-tool helper for jj orbit: writes the resolution made in the viewer to $output.\n\nCalled as: tool $output $path resolutions.json, where the JSON maps repo-relative paths to file contents."""\nimport json\nimport sys\n\noutput, path, table = sys.argv[1:4]\nwith open(table, encoding="utf-8") as f:\n    content = json.load(f).get(path)\nif content is None:\n    sys.exit(f"orbit: no resolution for {path}")\nwith open(output, "w", encoding="utf-8", newline="") as f:\n    f.write(content)\n'
LINE_OPS = {"split", "squash", "restore"}
MAX_WINDOW, MAX_OPS = 20000, 10000
CDN_THREE = "https://cdn.jsdelivr.net/npm/three@0.147.0/"
CDN_HLJS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
BOOKMARK_RE = re.compile(r"[^\s\x00-\x1f~^:?*\[\\@\"'][^\s\x00-\x1f~^:?*\[\\\"']*")


class ActionError(ValueError):
    pass


def ids(value, what, allow_empty=False):
    items = value if isinstance(value, list) else [value]
    if (not items and not allow_empty) or not all(isinstance(x, str) and COMMIT_RE.fullmatch(x) for x in items):
        raise ActionError(f"{what}: expected full commit ids")
    return items


def revset(items):
    return "|".join(items)


REMOTE_RE = re.compile(r"[A-Za-z0-9._-]+")
CHANGE_RE = re.compile(r"[k-z]{8,32}")
PLACE = {"onto": "-o", "after": "-A", "before": "-B"}
NETWORK = {"git-fetch", "git-push"}


def name_arg(a, key="name"):
    name = a.get(key)
    if not isinstance(name, str) or not BOOKMARK_RE.fullmatch(name):
        raise ActionError(f"{key}: invalid name")
    return name


def remote_arg(a, required=False):
    r = a.get("remote")
    if r in (None, "") and not required:
        return None
    if not isinstance(r, str) or not REMOTE_RE.fullmatch(r):
        raise ActionError("remote: invalid name")
    return r


def message_arg(a, required=False):
    msg = a.get("message")
    if msg is None and not required:
        return []
    if not isinstance(msg, str) or len(msg) > 65536:
        raise ActionError("message: text required")
    return [f"--message={msg}"]


def flags(a, **known):
    """Boolean request fields mapped to jj flags, e.g. flags(a, skip_emptied="--skip-emptied")."""
    return [flag for key, flag in known.items() if a.get(key) is True]


def filesets(a):
    paths = a.get("paths") or []
    if not isinstance(paths, list) or not all(isinstance(x, str) and x and "\x00" not in x for x in paths):
        raise ActionError("paths: list of file paths expected")
    return ["--", *(jj_export.root_file(x) for x in paths)] if paths else []


def place_args(a):
    place = PLACE.get(a.get("place"))
    if not place:
        raise ActionError("place onto/after/before required")
    return [place, revset(ids(a.get("dst"), "dst"))]


def remote_name(x):
    if not isinstance(x, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", x):
        raise ActionError("remote name: letters, digits, . _ - only")
    return x


def build_action(a):
    """Translate a request from the page into a jj command line. Only these shapes are accepted;
    every revision must be a full commit id and messages are passed as single arguments."""
    kind = a.get("op")
    one = lambda key="src": ids(a.get(key), key)[0]  # noqa: E731
    if kind == "rebase":
        mode = {"r": "-r", "s": "-s", "b": "-b"}.get(a.get("mode"))
        if not mode:
            raise ActionError("rebase: mode r/s/b required")
        return ["rebase", mode, revset(ids(a.get("src"), "src")), *place_args(a),
                *flags(a, skip_emptied="--skip-emptied", keep_divergent="--keep-divergent", simplify_parents="--simplify-parents")]
    if kind == "duplicate":
        return ["duplicate", revset(ids(a.get("src"), "src")), *place_args(a)]
    if kind == "revert":
        return ["revert", "-r", one(), *place_args(a)]
    if kind == "parallelize":
        return ["parallelize", f"{one('src')}::{one('to')}"]
    if kind == "abandon":
        rs = revset(ids(a.get("src"), "src"))
        return ["abandon", *(["--restore-descendants"] if a.get("restore") else []), *flags(a, retain_bookmarks="--retain-bookmarks"),
                f"({rs})::" if a.get("subtree") else rs]
    if kind == "describe":
        return ["describe", one(), *message_arg(a, True)]
    if kind == "commit":
        return ["commit", *message_arg(a, True)]
    if kind == "metaedit":
        argv = ["metaedit", one()]
        if a.get("update_author"):
            argv.append("--update-author")
        if a.get("update_author_timestamp"):
            argv.append("--update-author-timestamp")
        author = a.get("author")
        if author:
            if not isinstance(author, str) or not re.fullmatch(r"[^<>\n]+ <[^<>\s]+>", author):
                raise ActionError("author: expected 'Name <email>'")
            argv.append(f"--author={author}")
        return argv
    if kind == "simplify-parents":
        return ["simplify-parents", "-r", one()]
    if kind == "new":
        insert = {"after": ["-A"], "before": ["-B"]}.get(a.get("place"), [])
        return ["new", *(["--no-edit"] if a.get("no_edit") else []), *message_arg(a), *insert, revset(ids(a.get("parents"), "parents"))]
    if kind == "edit":
        return ["edit", one()]
    if kind == "squash":
        srcs = ids(a.get("src"), "src")
        into = a.get("into")
        if a.get("place") in PLACE:
            # squash -o/-A/-B: the changes go into a new commit at the destination
            msg = message_arg(a)
            if not msg and len(srcs) > 1:
                raise ActionError("squash into a new commit from several sources needs a description")
            argv = ["squash", "--from", revset(srcs), *place_args(a), *msg]
            return argv + flags(a, keep_emptied="--keep-emptied") + filesets(a)
        argv = ["squash", "--from", revset(srcs), "--into", ids(into, "into")[0]] if into else ["squash", "-r", srcs[0]]
        argv += message_arg(a) or ["--use-destination-message"]
        return argv + flags(a, keep_emptied="--keep-emptied") + filesets(a)
    if kind == "split":
        where = place_args(a) if a.get("place") in PLACE else []
        return ["split", "-r", one(), *message_arg(a, True), *(["--parallel"] if a.get("parallel") else []), *where, *filesets(a)]
    if kind == "restore":
        argv = ["restore"]
        if a.get("from"):
            argv += ["--from", one("from"), "--into", one("into")]
        else:
            argv += ["--changes-in", one("into")]
        if a.get("restore_descendants"):
            argv.append("--restore-descendants")
        return argv + filesets(a)
    if kind == "absorb":
        into = ["--into", revset(ids(a.get("into"), "into"))] if a.get("into") else []
        return ["absorb", "--from", one(), *into, *filesets(a)]
    if kind == "converge":
        cid = a.get("change")
        if not isinstance(cid, str) or not CHANGE_RE.fullmatch(cid):
            raise ActionError("converge: change id required")
        return ["converge", "--no-interactive", "-r", f"change_id({cid})"]
    if kind == "bookmark-set":
        return ["bookmark", "set", "-r", one("target"), *(["--allow-backwards"] if a.get("backwards") else []), "--", name_arg(a)]
    if kind == "bookmark-delete":
        names = a.get("names") or [a.get("name")]
        return ["bookmark", "delete", "--", *(name_arg({"name": x}) for x in names)]
    if kind == "bookmark-forget":
        return ["bookmark", "forget", *(["--include-remotes"] if a.get("include_remotes") else []), "--", name_arg(a)]
    if kind == "bookmark-rename":
        return ["bookmark", "rename", "--", name_arg(a, "old"), name_arg(a, "new")]
    if kind == "bookmark-advance":
        return ["bookmark", "advance", "--to", one("target")]
    if kind in ("bookmark-track", "bookmark-untrack", "tag-track", "tag-untrack"):
        group, verb = kind.split("-")
        return [group, verb, "--", f"{name_arg(a)}@{remote_arg(a, True)}"]
    if kind == "tag-set":
        return ["tag", "set", "-r", one("target"), *(["--allow-move"] if a.get("allow_move") else []), "--", name_arg(a)]
    if kind == "tag-delete":
        return ["tag", "delete", "--", name_arg(a)]
    if kind == "git-fetch":
        r = remote_arg(a)
        branches = a.get("branches") or []
        if not isinstance(branches, list) or not all(isinstance(b, str) and b and "\n" not in b for b in branches):
            raise ActionError("branches: list of names expected")
        return ["git", "fetch", *(["--remote", r] if r else []), *(["--all-remotes"] if a.get("all") else []),
                *flags(a, tracked="--tracked"), *(f"--branch={b}" for b in branches)]
    if kind == "git-push":
        r = remote_arg(a)
        opts = a.get("options") or []
        if not isinstance(opts, list) or not all(isinstance(o, str) and o and len(o) < 1000 and "\n" not in o and "\0" not in o for o in opts):
            raise ActionError("options: list of push options expected")
        mode = a.get("mode")
        if mode in ("tracked", "deleted"):
            target = ["--" + mode]
        elif a.get("change") and a.get("named"):
            target = ["--named", f"{name_arg({'name': a['named']})}={one('change')}"]
        elif a.get("change"):
            target = ["--change", one("change")]
        else:
            target = ["--bookmark", name_arg(a)]
        return ["git", "push", *(["--remote", r] if r else []), *target, *(f"--option={o}" for o in opts),
                *flags(a, allow_empty_description="--allow-empty-description", allow_private="--allow-private",
                       allow_conflicts="--allow-conflicts")]
    if kind == "workspace-add":
        name = name_arg(a)
        if "/" in name or name in (".", ".."):
            raise ActionError("workspace name must not contain '/'")
        return ["workspace", "add", "--name", name, "-r", one("target"), "{WORKSPACE_DIR}/" + name]
    if kind == "workspace-forget":
        return ["workspace", "forget", "--", name_arg(a)]
    if kind == "workspace-update-stale":
        return ["workspace", "update-stale"] + (["{IN_WORKSPACE}" + name_arg(a)] if a.get("name") else [])
    if kind == "resolve":
        paths = list((a.get("contents") or {}).keys()) or [a.get("path")]
        if not all(isinstance(p, str) and p and "\0" not in p for p in paths):
            raise ActionError("resolve: paths required")
        return ["resolve", "-r", one(), "--tool", "orbit-merge", "--", *(jj_export.root_file(p) for p in paths)]
    if kind == "workspace-remove":
        return ["workspace", "remove", "--", name_arg(a)]
    if kind == "workspace-snapshot":
        return ["util", "snapshot", "{IN_WORKSPACE}" + name_arg(a)]
    if kind == "op-restore":
        op = a.get("op_id")
        if not isinstance(op, str) or not re.fullmatch(r"[0-9a-f]{12,128}", op):
            raise ActionError("operation id required")
        return ["op", "restore", op]
    if kind == "undo-last":
        return ["undo"]
    if kind == "redo":
        return ["redo"]
    if kind == "file-track":
        return ["file", "track", *filesets({"paths": a.get("paths")})[1:]]
    if kind == "file-untrack":
        return ["file", "untrack", *filesets({"paths": a.get("paths")})[1:]]
    if kind == "file-chmod":
        mode = a.get("mode")
        if mode not in ("x", "n"):
            raise ActionError("file-chmod: mode x or n required")
        return ["file", "chmod", "-r", one(), mode, *filesets({"paths": a.get("paths")})[1:]]
    if kind in ("next", "prev"):
        return [kind, *(["--edit"] if a.get("edit") is True else [])]
    if kind in ("sign", "unsign"):
        return [kind, "-r", revset(ids(a.get("src"), "src"))]
    if kind == "git-remote-add":
        url = a.get("url")
        if not isinstance(url, str) or not url or url.startswith("-") or any(ch.isspace() for ch in url):
            raise ActionError("git-remote-add: URL required")
        return ["git", "remote", "add", "--", remote_name(a.get("name")), url]
    if kind == "git-remote-rename":
        return ["git", "remote", "rename", "--", remote_name(a.get("name")), remote_name(a.get("new_name"))]
    if kind == "git-remote-remove":
        return ["git", "remote", "remove", "--", remote_name(a.get("name"))]
    if kind == "op-abandon":
        op = a.get("op_id")
        if not isinstance(op, str) or not re.fullmatch(r"[0-9a-f]{12,128}", op):
            raise ActionError("op-abandon: operation id required")
        return ["op", "abandon", f"..{op}-"]
    if kind == "undo":
        op = a.get("op_id")
        if not isinstance(op, str) or not re.fullmatch(r"[0-9a-f]{12,128}", op):
            raise ActionError("undo: operation id required")
        return ["op", "revert", op]
    raise ActionError(f"unknown action {kind!r}")


def conflicted_files(repo, commit_id):
    root = jj_export.workspace_root(repo)
    code, out, err = run_jj(root, ["resolve", "--list", "-r", commit_id], ["--ignore-working-copy"], timeout=60, cwd=root)
    if code != 0:
        if "No conflicts" in err or "no conflicts" in err.lower():
            return {"files": []}
        raise jj_export.JJError(err.strip())
    files = []
    for line in out.splitlines():
        m = re.match(r"^(.*?)\s{2,}(.*)$", line)
        if m:
            files.append({"path": m.group(1), "kind": m.group(2)})
    return {"files": files, "root": root}


def run_jj(repo, argv, extra=(), timeout=180, cwd=None):
    """No editor, no pager, no credential prompt: anything interactive fails instead of hanging."""
    cmd = ["jj", "--no-pager", "--color=never", "-R", repo, *extra, *argv]
    env = dict(os.environ, JJ_EDITOR="false", EDITOR="false", VISUAL="false", GIT_TERMINAL_PROMPT="0",
               SSH_ASKPASS="", GIT_ASKPASS="")
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout, stdin=subprocess.DEVNULL, cwd=cwd)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout} s"
    return proc.returncode, proc.stdout, proc.stderr


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "jj-orbit"
    live: Live = None
    page: bytes = b""

    def log_message(self, fmt, *args):
        if self.server.verbose:
            log(fmt % args)

    def send(self, code, body, ctype, extra=None, body_gz=None):
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if gz:
            body = body_gz if body_gz is not None else gzip.compress(body, 5)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def graph(self):
        lv = self.live
        self.send(200, lv.body, "application/json; charset=utf-8", {"X-Orbit-Graph": str(lv.graph_no)}, lv.body_gz)

    def status(self):
        lv = self.live
        return {"op": lv.op, "busy": lv.busy, "error": lv.error, "ms": lv.ms, "graph": lv.graph_no,
                "actions": not self.server.read_only, "version": VERSION,
                "repo": str(Path(lv.repo or ".").resolve()), "watching": not lv.args.no_watch}

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            self.send(200, self.page, "text/html; charset=utf-8")
        elif path == "/api/graph":
            self.graph()
        elif path == "/api/status":
            self.send(200, json.dumps(self.status()).encode(), "application/json")
        elif path == "/api/events":
            self.events()
        elif path == "/api/evolog":
            self.evolog()
        elif path == "/api/files":
            self.commit_query(lambda q, cid: jj_export.changed_files(self.live.repo, cid), "files")
        elif path == "/api/diff":
            self.commit_query(lambda q, cid: jj_export.file_diff(self.live.repo, cid, q.get("path", [""])[0]), "diff")
        elif path == "/api/file":
            self.commit_query(lambda q, cid: jj_export.file_content(self.live.repo, cid, q.get("path", [""])[0]), "file")
        elif path == "/api/pair":
            self.pair()
        elif path == "/api/activity":
            self.send(200, json.dumps(list(self.live.activity)).encode(), "application/json")
        elif path == "/api/bookmarks-merged":
            code, out, err = run_jj(str(Path(self.live.repo or ".").resolve()),
                                    ["log", "--no-graph", "-r", "(bookmarks() & ::trunk()) ~ trunk()", "-T",
                                     'local_bookmarks.map(|b| b.name()).join("\\n") ++ "\\n"'], ["--ignore-working-copy"], timeout=60)
            names = sorted({x for x in out.split("\n") if x.strip()}) if code == 0 else []
            self.send(200, json.dumps({"ok": code == 0, "names": names, "error": err.strip() if code else None}).encode(), "application/json")
        elif path.startswith("/vendor/"):
            rel = Path(unquote(path[len("/vendor/"):]))
            target = (self.vendor / rel).resolve()
            if ".." in rel.parts or not str(target).startswith(str(self.vendor.resolve())) or not target.is_file():
                self.send(404, b"not found", "text/plain")
            else:
                ctype = "text/javascript; charset=utf-8" if target.suffix == ".js" else "text/plain; charset=utf-8"
                self.send(200, target.read_bytes(), ctype)
        elif path == "/api/remotes":
            code, out, err = run_jj(str(Path(self.live.repo or ".").resolve()), ["git", "remote", "list"], ["--ignore-working-copy"], timeout=30)
            rows = [dict(zip(("name", "url"), line.split(None, 1))) for line in out.splitlines() if line.strip()] if code == 0 else []
            self.send(200, json.dumps(rows).encode(), "application/json")
        elif path == "/api/follow":
            self.file_query(lambda cid, p: jj_export.follow_file(self.live.repo, cid, p), "follow")
        elif path == "/api/annotate":
            self.file_query(lambda cid, p: jj_export.annotate(self.live.repo, cid, p), "annotate")
        elif path == "/api/conflict":
            self.file_query(lambda cid, p: jj_export.conflict_text(self.live.repo, cid, p), "conflict")
        elif path == "/api/tree":
            self.commit_query(lambda q, cid: jj_export.file_list(self.live.repo, cid), "tree")
        elif path == "/api/texts":
            self.texts()
        elif path == "/reviewdiff-core.js":
            core = Path(__file__).resolve().parent / "reviewdiff-core.js"
            if core.is_file():
                self.send(200, core.read_bytes(), "text/javascript; charset=utf-8")
            else:
                self.send(404, b"reviewdiff-core.js not found next to the server", "text/plain")
        elif path == "/api/hunks":
            self.commit_query(lambda q, cid: jj_export.line_blocks(self.live.repo, cid), "hunks")
        elif path == "/api/conflicts":
            self.commit_query(lambda q, cid: conflicted_files(self.live.repo, cid), "conflicts")
        elif path == "/api/revset":
            self.revset_query()
        elif path == "/api/opshow":
            self.opshow()
        else:
            self.send(404, b"not found", "text/plain")

    def cached(self, key, fn):
        lv = self.live
        with lv.lazy_lock:
            hit = lv.lazy.get(key)
        if hit is None:
            try:
                hit = fn()
            except jj_export.JJError as e:
                self.send(500, str(e).encode(), "text/plain; charset=utf-8")
                return
            with lv.lazy_lock:
                lv.lazy[key] = hit
        self.send(200, json.dumps(hit).encode(), "application/json")

    def file_query(self, fn, tag):
        q = parse_qs(urlparse(self.path).query)
        cid, p = q.get("id", [""])[0], q.get("path", [""])[0]
        if not COMMIT_RE.fullmatch(cid) or not p:
            self.send(400, b"expected id=<commit>&path=<path>", "text/plain")
            return
        self.cached((tag, cid, p), lambda: fn(cid, p))

    def texts(self):
        q = parse_qs(urlparse(self.path).query)
        cid, a, b = q.get("id", [""])[0], q.get("from", [""])[0], q.get("to", [""])[0]
        if cid and COMMIT_RE.fullmatch(cid):
            self.cached(("texts", cid), lambda: jj_export.commit_texts(self.live.repo, cid))
        elif COMMIT_RE.fullmatch(a) and COMMIT_RE.fullmatch(b):
            self.cached(("texts", a, b), lambda: jj_export.pair_texts(self.live.repo, a, b))
        else:
            self.send(400, b"expected id= or from=&to= with full commit ids", "text/plain")

    def revset_query(self):
        q = parse_qs(urlparse(self.path).query).get("q", [""])[0]
        if not q.strip() or len(q) > 2000:
            self.send(400, b"revset required", "text/plain")
            return
        code, out, err = run_jj(str(Path(self.live.repo or ".").resolve()),
                                ["log", "--no-graph", "--limit", "20000", "-r", q, "-T", 'commit_id ++ "\\n"'],
                                ["--ignore-working-copy"], timeout=60)
        body = {"ok": code == 0, "ids": out.split() if code == 0 else [], "error": err.strip() if code else None}
        self.send(200, json.dumps(body).encode(), "application/json")

    def pair(self):
        q = parse_qs(urlparse(self.path).query)
        kind, a, b = q.get("kind", [""])[0], q.get("from", [""])[0], q.get("to", [""])[0]
        if kind not in ("diff", "interdiff") or not COMMIT_RE.fullmatch(a) or not COMMIT_RE.fullmatch(b):
            self.send(400, b"expected kind=diff|interdiff and two full commit ids", "text/plain")
            return
        self.cached(("pair", kind, a, b), lambda: jj_export.pair_diff(self.live.repo, kind, a, b))

    def opshow(self):
        op = parse_qs(urlparse(self.path).query).get("id", [""])[0]
        if not re.fullmatch(r"[0-9a-f]{12,128}", op):
            self.send(400, b"expected an operation id", "text/plain")
            return
        self.cached(("op", op), lambda: jj_export.op_details(self.live.repo, op))

    def commit_query(self, fn, kind):
        """Read-only per-commit queries; a commit id names fixed content, so answers are cached."""
        q = parse_qs(urlparse(self.path).query)
        cid = q.get("id", [""])[0]
        if not re.fullmatch(r"[0-9a-f]{40}", cid):
            self.send(400, b"expected a full commit id", "text/plain")
            return
        key = (kind, cid, q.get("path", [""])[0])
        lv = self.live
        with lv.lazy_lock:
            hit = lv.lazy.get(key)
        if hit is None:
            try:
                hit = fn(q, cid)
            except jj_export.JJError as e:
                self.send(500, str(e).encode(), "text/plain; charset=utf-8")
                return
            with lv.lazy_lock:
                lv.lazy[key] = hit
        self.send(200, json.dumps(hit).encode(), "application/json")

    def evolog(self):
        cid = parse_qs(urlparse(self.path).query).get("id", [""])[0]
        if not re.fullmatch(r"[0-9a-f]{40}", cid):
            self.send(400, b"expected a full commit id", "text/plain")
            return
        try:
            hit = self.live.evolog(cid)
        except jj_export.JJError as e:
            self.send(500, str(e).encode(), "text/plain; charset=utf-8")
            return
        self.send(200, json.dumps(hit).encode(), "application/json")

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/action":
            if self.server.read_only:
                self.send(403, b"server runs with --read-only", "text/plain")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(min(length, 1 << 20)) or b"{}")
                result = self.live.action(request)
            except (ActionError, json.JSONDecodeError) as e:
                self.send(400, str(e).encode(), "text/plain; charset=utf-8")
                return
            except jj_export.JJError as e:
                self.send(500, str(e).encode(), "text/plain; charset=utf-8")
                return
            self.send(200, json.dumps(result).encode(), "application/json")
            return
        if url.path == "/api/state":
            length = int(self.headers.get("Content-Length") or 0)
            if length > 200_000_000:
                self.send(413, b'{"error": "too large"}', "application/json")
                return
            body = self.rfile.read(length)
            try:
                if json.loads(body).get("kind") != "jj-orbit-state":
                    raise ValueError
            except ValueError:
                self.send(400, b'{"error": "not a jj-orbit state"}', "application/json")
                return
            name = time.strftime("jj-orbit-state-%Y%m%d-%H%M%S.json")
            target = Path.cwd() / name
            target.write_bytes(body)
            log(f"saved viewer state to {target}")
            self.send(200, json.dumps({"path": str(target)}).encode(), "application/json")
            return
        if url.path == "/api/more":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                req = json.loads(self.rfile.read(min(length, 1 << 16)) or b"{}")
                revs, ops = int(req.get("revs") or 0), int(req.get("ops") or 0)
                if req.get("set_revs") is not None:
                    self.live.args.window = max(1, min(MAX_WINDOW, int(req["set_revs"])))
                if req.get("set_ops") is not None:
                    self.live.args.ops = max(0, min(MAX_OPS, int(req["set_ops"])))
            except (ValueError, TypeError, json.JSONDecodeError):
                self.send(400, b"expected {revs: n} or {ops: n}", "text/plain")
                return
            # Grow what the server exports; later exports keep the larger window.
            self.live.args.window = max(1, min(MAX_WINDOW, self.live.args.window + max(0, min(revs, 2000))))
            self.live.args.ops = max(0, min(MAX_OPS, self.live.args.ops + max(0, min(ops, 2000))))
            if self.live.export(snapshot=False):
                self.send(200, json.dumps({"window": self.live.args.window, "ops": self.live.args.ops, "graph": self.live.graph_no}).encode(), "application/json")
            else:
                self.send(500, (self.live.error or "export failed").encode(), "text/plain; charset=utf-8")
            return
        if url.path != "/api/refresh":
            self.send(404, b"not found", "text/plain")
            return
        snapshot = parse_qs(url.query).get("snapshot", ["1"])[0] != "0"
        if self.live.export(snapshot=snapshot):
            self.graph()
        else:
            self.send(500, (self.live.error or "export failed").encode(), "text/plain; charset=utf-8")

    def events(self):
        lv = self.live
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        def emit(event, payload):
            self.wfile.write(f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        try:
            emit("hello", self.status())
            seen = lv.version
            while True:
                with lv.cond:
                    lv.cond.wait_for(lambda: lv.version != seen, timeout=15)
                    pending = [e for e in lv.log if e[0] > seen]
                    seen = lv.version
                if not pending:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                for _, event, payload in pending:
                    emit(event, payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def main():
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", action="version", version=f"jj-orbit {VERSION}")
    ap.add_argument("-R", "--repository", default=".", help="path to the jj repo (default: cwd)")
    ap.add_argument("-r", "--revisions", help="revset to show (default: mutable work plus a trunk window)")
    ap.add_argument("--window", type=int, default=80, help="trunk commits to include with the default revset")
    ap.add_argument("--ops", type=int, default=100, help="operations for the op-log scrubber (0 disables it)")
    ap.add_argument("--evolog", choices=["lazy", "eager", "off"], default="lazy",
                    help="earlier versions: read when a commit is selected (default), all up front, or not at all")
    ap.add_argument("--no-evolog", dest="evolog", action="store_const", const="off", help="same as --evolog off")
    ap.add_argument("--evolog-depth", type=int, default=jj_export.DEFAULT_EVOLOG_DEPTH, help="earlier versions per commit (0: all)")
    ap.add_argument("--evolog-budget", type=float, default=30.0, help="seconds for reading damaged evologs one by one")
    ap.add_argument("-j", "--jobs", type=int, default=jj_export.DEFAULT_JOBS, help="parallel jj processes")
    ap.add_argument("--no-watch", action="store_true", help="only re-export when the page asks for it")
    ap.add_argument("--interval", type=float, default=0.5, help="seconds between op-head checks")
    ap.add_argument("--debounce", type=float, default=0.3, help="wait for the op heads to settle before exporting")
    ap.add_argument("--viewer", default=str(here / "jj-orbit.html"), help="path to jj-orbit.html")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--open", action="store_true", help="open the page in the browser")
    ap.add_argument("--profile", action="store_true", help="print where each export spends its time")
    ap.add_argument("--read-only", action="store_true", help="disable rebase, abandon and the other actions")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    try:
        html = Path(args.viewer).read_text(encoding="utf-8")
    except OSError as e:
        sys.exit(f"cannot read viewer: {e}")
    if not DEMO_RE.search(html):
        sys.exit(f"{args.viewer} does not look like jj-orbit.html")
    parts = {"server": VERSION, "exporter": getattr(jj_export, "VERSION", "old"),
             "viewer": (VERSION_RE.search(html) or [None, "old"])[1]}
    log(f"jj-orbit {VERSION}: exporter {jj_export.__file__}, viewer {args.viewer}")
    if len(set(parts.values())) > 1:
        sys.exit("version mismatch, replace all three files from the same bundle: "
                 + ", ".join(f"{k} {v}" for k, v in parts.items()))
    page = DEMO_RE.sub(lambda m: m.group(1) + '{"server":true}' + m.group(3), html, count=1)
    vendor = here / "vendor"
    if (vendor / "three" / "build" / "three.min.js").is_file():
        page = page.replace(CDN_THREE, "vendor/three/")
    if (vendor / "highlight.min.js").is_file():
        page = page.replace(CDN_HLJS, "vendor/highlight.min.js")
    Handler.vendor = vendor

    try:
        live = Live(args)
    except jj_export.JJError as e:
        sys.exit(str(e))
    log(f"exporting {Path(args.repository).resolve()} ...")
    if not live.export(snapshot=True):
        sys.exit(1)
    if not args.no_watch:
        threading.Thread(target=live.watch, daemon=True).start()

    Handler.live = live
    Handler.page = page.encode()
    httpd = QuietServer((args.host, args.port), Handler)
    httpd.verbose = args.verbose
    httpd.read_only = args.read_only
    url = f"http://{args.host}:{args.port}/"
    log(f"serving {url}" + ("" if args.no_watch else f", watching {live.heads_dir}"))
    if args.open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
