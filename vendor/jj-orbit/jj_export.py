#!/usr/bin/env python3
"""Export a jj repository's commit graph, evolog and op history as JSON for jj-orbit."""

import argparse
import copy
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

VERSION = "0.32.2"
ROOT_COMMIT = "0" * 40


class JJError(RuntimeError):
    pass

COMMIT_TEMPLATE = (
    '"{\\"c\\":" ++ json(self)'
    ' ++ ",\\"cp\\":" ++ json(stringify(change_id.shortest().prefix()))'
    ' ++ ",\\"ip\\":" ++ json(stringify(commit_id.shortest().prefix()))'
    ' ++ ",\\"lb\\":[" ++ local_bookmarks.map(|b| json(stringify(b.name()))).join(",") ++ "]"'
    ' ++ ",\\"rb\\":[" ++ remote_bookmarks.map(|b| json(stringify(b.name() ++ "@" ++ b.remote()))).join(",") ++ "]"'
    ' ++ ",\\"tags\\":[" ++ tags.map(|t| json(stringify(t.name()))).join(",") ++ "]"'
    ' ++ ",\\"conflict\\":" ++ json(conflict)'
    ' ++ ",\\"empty\\":" ++ json(empty)'
    ' ++ ",\\"immutable\\":" ++ json(immutable)'
    ' ++ ",\\"divergent\\":" ++ json(divergent)'
    ' ++ ",\\"co\\":" ++ json(change_offset)'
    ' ++ ",\\"signed\\":" ++ if(signature, "true", "false")'
    ' ++ ",\\"wc\\":" ++ json(current_working_copy)'
    ' ++ ",\\"wcs\\":" ++ json(stringify(working_copies))'
    ' ++ "}\\n"'
)

EVOLOG_TEMPLATE = (
    'json(commit.change_id()) ++ "\\t" ++ json(commit.commit_id())'
    ' ++ "\\t" ++ json(stringify(commit.change_id().shortest().prefix()))'
    ' ++ "\\t" ++ json(stringify(commit.commit_id().shortest().prefix()))'
    ' ++ "\\t" ++ json(commit.description().first_line())'
    ' ++ "\\t" ++ if(operation, json(operation.description()), "null")'
    ' ++ "\\t" ++ if(operation, json(operation.time().start()), "null") ++ "\\n"'
)

EVOLOG_BATCH_TEMPLATE = (
    'json(commit.change_id()) ++ "\\t" ++ json(commit.commit_id())'
    ' ++ "\\t" ++ json(stringify(commit.change_id().shortest().prefix()))'
    ' ++ "\\t" ++ json(stringify(commit.commit_id().shortest().prefix()))'
    ' ++ "\\t" ++ json(commit.description().first_line())'
    ' ++ "\\t" ++ if(operation, json(operation.description()), "null")'
    ' ++ "\\t" ++ if(operation, json(operation.time().start()), "null")'
    ' ++ "\\t[" ++ predecessors.map(|p| json(p.commit_id())).join(",") ++ "]\\n"'
)

DEFAULT_JOBS = min(8, os.cpu_count() or 4)
DEFAULT_EVOLOG_DEPTH = 30

OP_TEMPLATE = (
    'json(stringify(id)) ++ "\\t" ++ json(description)'
    ' ++ "\\t" ++ json(time.start()) ++ "\\t" ++ json(stringify(workspace_name)) ++ "\\n"'
)

BOOKMARK_TEMPLATE = (
    'json(stringify(name)) ++ "\\t" ++ json(stringify(remote)) ++ "\\t" ++ json(present)'
    ' ++ "\\t" ++ json(conflict) ++ "\\t" ++ json(tracked) ++ "\\t" ++ json(synced)'
    ' ++ "\\t[" ++ added_targets.map(|c| json(c.commit_id())).join(",") ++ "]"'
    ' ++ "\\t" ++ if(tracked, json(tracking_ahead_count.exact()), "null")'
    ' ++ "\\t" ++ if(tracked, json(tracking_behind_count.exact()), "null") ++ "\\n"'
)

WORKSPACE_TEMPLATE = 'json(stringify(name)) ++ "\\t" ++ json(target.commit_id()) ++ "\\t" ++ json(stringify(self.root())) ++ "\\n"'

DEFAULT_REVSET = "present(@) | working_copies() | mutable() | roots(ancestors(trunk(), {window}))::"


PROFILE = []


class RepoAt(str):
    """A repository path that makes every jj call load the repo at a given operation."""

    def __new__(cls, path, at_op):
        obj = super().__new__(cls, path)
        obj.at_op = at_op
        return obj


def jj(repo, *args, snapshot=False, tag=None, cwd=None):
    cmd = ["jj", "--no-pager", "--color=never"] + ([] if snapshot else ["--ignore-working-copy"])
    if repo:
        cmd += ["-R", str(repo)]
    if getattr(repo, "at_op", None) and "--at-op" not in args:
        cmd += ["--at-op", repo.at_op]
    t0 = time.monotonic()
    proc = subprocess.run(cmd + list(args), capture_output=True, text=True, cwd=cwd)
    PROFILE.append((tag or args[0], time.monotonic() - t0, len(proc.stdout)))
    if proc.returncode != 0:
        raise JJError(f"jj {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc.stdout


def log_commits(repo, revset, at_op=None, snapshot=False, tag=None):
    args = ["log", "--no-graph", "-r", revset, "-T", COMMIT_TEMPLATE]
    if at_op:
        args = ["--at-op", at_op] + args
    rows = []
    for line in jj(repo, *args, snapshot=snapshot and at_op is None, tag=tag).splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        c = r["c"]
        if c["commit_id"] == ROOT_COMMIT:
            continue
        rows.append({
            "id": c["commit_id"],
            "cid": c["change_id"],
            "ip": len(r["ip"]),
            "cp": len(r["cp"]),
            "parents": [p for p in c["parents"] if p != ROOT_COMMIT],
            "desc": c["description"].rstrip("\n"),
            "author": c["author"]["name"],
            "email": c["author"]["email"],
            "ts": c["author"]["timestamp"],
            "cts": c["committer"]["timestamp"],
            "lb": r["lb"],
            "rb": [b for b in r["rb"] if not b.endswith("@git")],
            "tags": r["tags"],
            "conflict": r["conflict"],
            "empty": r["empty"],
            "immutable": r["immutable"],
            "divergent": r["divergent"],
            "co": r.get("co"),
            "signed": r.get("signed", False),
            "wc": r["wc"],
            "wcs": [w.rstrip("@") for w in r["wcs"].split()],
        })
    return rows


def connect_elided(repo, revset, commits, warnings=None, jobs=DEFAULT_JOBS):
    """For parents outside the exported set, link to the nearest exported ancestors."""
    ids = {c["id"] for c in commits}
    missing = sorted({p for c in commits for p in c["parents"] if p not in ids})[:300]

    def nearest_of(p):
        try:
            out = jj(repo, "log", "--no-graph", "-r", f"heads(::{p} & ({revset}))", "-T", 'commit_id ++ "\\n"',
                     tag="elided parents")
            return p, [x for x in out.split() if x and x != ROOT_COMMIT], None
        except JJError as e:
            return p, None, str(e).strip().splitlines()[-1]

    nearest = {}
    with ThreadPoolExecutor(jobs) as pool:
        for p, found, why in pool.map(nearest_of, missing):
            if found is None:
                if warnings is not None:
                    warnings.append(f"ancestors of {p[:12]} unreadable: {why}")
                continue
            nearest[p] = found
    for c in commits:
        direct, elided = [], []
        for p in c["parents"]:
            if p in ids:
                direct.append(p)
            else:
                for a in nearest.get(p, []):
                    if a not in elided and a not in direct:
                        elided.append(a)
        c["parents"], c["elided"] = direct, elided


def evolog_text(repo, commit_id, warnings, depth=0):
    """jj evolog fails outright when an older predecessor object is gone (e.g. pruned by gc).
    In that case keep the longest prefix of the history that can still be read."""
    args = ["evolog", "--no-graph", "-r", commit_id, "-T", EVOLOG_TEMPLATE]
    limit = ["--limit", str(depth + 1)] if depth else []
    try:
        return jj(repo, *args, *limit, tag="evolog (single commit)")
    except JJError as e:
        first_error = str(e)
    good, ok_text, bad = 0, "", depth + 1 if depth else None
    n = 1
    while bad is None:
        try:
            ok_text, good = jj(repo, *args, "--limit", str(n), tag="evolog (single commit)"), n
            if ok_text.count("\n") < n:
                return ok_text
            n *= 2
        except JJError:
            bad = n
    while bad - good > 1:
        mid = (good + bad) // 2
        try:
            ok_text, good = jj(repo, *args, "--limit", str(mid), tag="evolog (single commit)"), mid
        except JJError:
            bad = mid
    reason = first_error.strip().splitlines()[-1]
    warnings.append(f"evolog of {commit_id[:12]} truncated after {good} entries: {reason}")
    return ok_text


def parse_evolog_line(line, with_preds=False):
    parts = line.split("\t")
    change, commit, cp, ip, desc, op, ts = (json.loads(x) for x in parts[:7])
    e = {"id": commit, "cid": change, "cp": len(cp), "ip": len(ip), "desc": desc, "op": op, "ts": ts}
    if with_preds:
        e["preds"] = json.loads(parts[7])
    return e


def evolog_single(repo, commit_id, warnings, depth=0):
    out = evolog_text(repo, commit_id, warnings, depth)
    return [parse_evolog_line(l) for l in out.splitlines() if l.strip()]


def order_history(start, entries):
    """Predecessor graph from one batched evolog call -> one commit's history, newest first."""
    seen, stack = set(), [start]
    while stack:
        k = stack.pop()
        if k in seen or k not in entries:
            continue
        seen.add(k)
        stack.extend(entries[k]["preds"])
    pending = {k: 0 for k in seen}
    for k in seen:
        for p in entries[k]["preds"]:
            if p in pending:
                pending[p] += 1
    seq = {}
    ready = [k for k, n in pending.items() if n == 0]
    for k in ready:
        seq[k] = len(seq)
    out = []
    while ready:
        ready.sort(key=lambda k: (entries[k]["ts"] or "", -seq[k]))
        k = ready.pop()
        out.append(k)
        for p in entries[k]["preds"]:
            if p in pending:
                pending[p] -= 1
                if pending[p] == 0:
                    seq[p] = len(seq)
                    ready.append(p)
    return [{x: v for x, v in entries[k].items() if x != "preds"} for k in out if k != start]


def evolog(repo, commits, cache=None, warnings=None, depth=0, jobs=DEFAULT_JOBS, budget=30.0):
    """Predecessor versions per current mutable commit, newest first.

    jj finds predecessors by walking the operation log, so every jj evolog call costs a walk; one batched
    call covers many commits with a single walk. If a batch fails (an unreadable predecessor), it is
    bisected so only the affected commits fall back to single, depth-limited calls. A commit's evolog
    never changes, so results are cached."""
    cache = {} if cache is None else cache
    warnings = [] if warnings is None else warnings
    todo = [c["id"] for c in commits if not c["immutable"] and c["id"] not in cache]
    bad = []

    def batch(ids):
        try:
            out = jj(repo, "evolog", "--no-graph", "-r", "|".join(ids), "-T", EVOLOG_BATCH_TEMPLATE, tag="evolog (batch)")
        except JJError:
            return ids, None
        entries = {}
        for line in out.splitlines():
            if line.strip():
                e = parse_evolog_line(line, with_preds=True)
                entries[e["id"]] = e
        return ids, entries

    groups = [todo[i:i + 200] for i in range(0, len(todo), 200)]
    with ThreadPoolExecutor(jobs) as pool:
        while groups:
            failed = []
            for ids, entries in pool.map(batch, groups):
                if entries is not None:
                    for cid in ids:
                        cache[cid] = order_history(cid, entries)
                elif len(ids) == 1:
                    bad.append(ids[0])
                else:
                    failed.append(ids)
            groups = [half for ids in failed for half in (ids[:len(ids) // 2], ids[len(ids) // 2:])]
    if bad:
        t0 = time.monotonic()

        def single(cid):
            if time.monotonic() - t0 > budget:
                return cid, None
            return cid, evolog_single(repo, cid, warnings, depth)

        skipped = 0
        with ThreadPoolExecutor(jobs) as pool:
            for cid, entries in pool.map(single, bad):
                if entries is None:
                    skipped += 1
                    cache[cid] = []
                else:
                    cache[cid] = [e for e in entries if e["id"] != cid]
        if skipped:
            warnings.append(f"evolog skipped for {skipped} commits after {budget:.0f} s (raise --evolog-budget)")
    result = {}
    for c in commits:
        entries = cache.get(c["id"])
        if entries:
            result[c["id"]] = entries[:depth] if depth else entries
    return result


def bookmarks(repo):
    """Local and remote bookmarks with tracking state; the internal 'git' remote is skipped."""
    rows = []
    for line in jj(repo, "bookmark", "list", "--all-remotes", "-T", BOOKMARK_TEMPLATE, tag="bookmarks").splitlines():
        if not line.strip():
            continue
        name, remote, present, conflict, tracked, synced, targets, ahead, behind = (json.loads(x) for x in line.split("\t"))
        if remote == "git":
            continue
        rows.append({
            "name": name, "remote": remote or None, "present": present, "conflict": conflict,
            "tracked": tracked, "synced": synced, "targets": [t for t in targets if t != ROOT_COMMIT],
            "ahead": ahead, "behind": behind,
        })
    return rows


def divergence_revset(bms):
    """Commits needed to show both sides of every tracked bookmark that is out of sync."""
    local = {b["name"]: b["targets"] for b in bms if b["remote"] is None}
    parts = []
    for b in bms:
        if b["remote"] is None or not b["tracked"] or b["synced"] or not b["targets"]:
            continue
        lt = local.get(b["name"]) or []
        rt = "|".join(b["targets"])
        if lt:
            lt = "|".join(lt)
            parts.append(f"(::({rt}) ~ ::({lt})) | (::({lt}) ~ ::({rt})) | fork_point({lt}|{rt})")
        else:
            parts.append(f"({rt})")
    return " | ".join(parts)


def workspaces(repo):
    rows = []
    for line in jj(repo, "workspace", "list", "-T", WORKSPACE_TEMPLATE).splitlines():
        if line.strip():
            name, target, root = (json.loads(x) for x in line.split("\t"))
            rows.append({"name": name, "target": target, "root": root})
    here = jj(repo, "workspace", "root").strip()
    for w in rows:
        w["current"] = w["root"] == here
    return stale_workspaces(repo, rows) if len(rows) > 1 else rows


def more_revisions(repo, window):
    """Whether trunk has ancestors older than the exported window."""
    try:
        out = jj(repo, "log", "--no-graph", "--limit", "1", "-r", f"roots(ancestors(trunk(), {int(window)}))- ~ root()",
                 "-T", "commit_id", tag="more revisions")
    except JJError:
        return False
    return bool(out.strip())


def more_operations(repo, limit):
    out = jj(repo, "op", "log", "--no-graph", "--limit", str(int(limit) + 1), "-T", 'id.short() ++ "\\n"', tag="more ops")
    return len(out.split()) > limit


def op_history(repo, limit):
    out = jj(repo, "op", "log", "--no-graph", "--limit", str(limit), "-T", OP_TEMPLATE, tag="op log")
    ops = []
    for line in out.splitlines():
        if line.strip():
            oid, desc, ts, ws = (json.loads(x) for x in line.split("\t"))
            ops.append({"id": oid[:12], "full": oid, "desc": desc, "ts": ts, "ws": ws.rstrip("@") or None})
    ops.reverse()
    return ops


FILES_TEMPLATE = (
    'self.diff().files().map(|f| json(f.status()) ++ "\\t" ++ json(f.path().display())'
    ' ++ "\\t" ++ json(f.source().path().display())).join("\\n")'
    ' ++ "\\n\\x1e\\n" ++ self.diff().stat().files().map(|f| json(f.path().display())'
    ' ++ "\\t" ++ json(f.lines_added()) ++ "\\t" ++ json(f.lines_removed())).join("\\n") ++ "\\n"'
)


_ROOTS = {}


def workspace_root(repo):
    """jj prints paths relative to the current directory, so path queries run from the workspace root."""
    if repo not in _ROOTS:
        _ROOTS[repo] = jj(repo, "workspace", "root").strip()
    return _ROOTS[repo]


def changed_files(repo, commit_id, limit=1000):
    """Files a commit changes relative to its parents, with line counts; paths are repo-relative."""
    root = workspace_root(repo)
    out = jj(root, "log", "--no-graph", "-r", commit_id, "-T", FILES_TEMPLATE, tag="changed files", cwd=root)
    head, _, stat = out.partition("\x1e")
    counts = {}
    for line in stat.splitlines():
        if line.strip():
            path, added, removed = (json.loads(x) for x in line.split("\t"))
            counts[path] = (added, removed)
    files = []
    for line in head.splitlines():
        if line.strip():
            status, path, source = (json.loads(x) for x in line.split("\t"))
            added, removed = counts.get(path, (None, None))
            files.append({"status": status, "path": path, "source": source if source != path else None,
                          "added": added, "removed": removed})
    return {"files": files[:limit], "total": len(files)}


def root_file(path):
    """A fileset naming exactly one repo-relative path."""
    return 'root-file:"' + path.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_git_diff(text):
    """Split `jj diff --git` output into per-file entries with status and line counts."""
    files, cur = [], None
    for line in text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            cur = {"status": "modified", "path": None, "source": None, "added": 0, "removed": 0, "diff": line}
            files.append(cur)
            continue
        if cur is None:
            continue
        cur["diff"] += line
        if line.startswith("new file mode"):
            cur["status"] = "added"
        elif line.startswith("deleted file mode"):
            cur["status"] = "removed"
        elif line.startswith("rename from "):
            cur["status"], cur["source"] = "renamed", line[12:].rstrip("\n")
        elif line.startswith("copy from "):
            cur["status"], cur["source"] = "copied", line[10:].rstrip("\n")
        elif line.startswith("+++ ") and cur["path"] is None:
            p = line[4:].rstrip("\n")
            cur["path"] = p[2:] if p.startswith("b/") else None
        elif line.startswith("--- ") and cur["path"] is None and cur["status"] == "removed":
            p = line[4:].rstrip("\n")
            cur["path"] = p[2:] if p.startswith("a/") else None
        elif line.startswith("+") and not line.startswith("+++"):
            cur["added"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            cur["removed"] += 1
    for f in files:
        if f["path"] is None:
            head = f["diff"].split("\n", 1)[0]
            f["path"] = head.rsplit(" b/", 1)[-1]
    return files


def pair_diff(repo, kind, a, b, max_bytes=2_000_000):
    """Changed files between two commits (`diff`) or between their changes (`interdiff`)."""
    root = workspace_root(repo)
    out = jj(root, kind, "--git", "--from", a, "--to", b, tag=kind, cwd=root)
    files = parse_git_diff(out[:max_bytes])
    return {"files": files, "total": len(files), "truncated": len(out) > max_bytes}


def file_content(repo, commit_id, path, max_bytes=500_000):
    root = workspace_root(repo)
    out = subprocess.run(["jj", "--no-pager", "--ignore-working-copy", "-R", root, "file", "show", "-r", commit_id,
                          "--", root_file(path)], capture_output=True, cwd=root)
    if out.returncode:
        raise JJError(out.stderr.decode(errors="replace"))
    data = out.stdout
    if b"\x00" in data[:8192]:
        return {"binary": True, "size": len(data)}
    return {"text": data[:max_bytes].decode(errors="replace"), "size": len(data), "truncated": len(data) > max_bytes}


def file_bytes(repo, rev, path):
    root = workspace_root(repo)
    out = subprocess.run(["jj", "--no-pager", "--ignore-working-copy", "-R", root, "file", "show", "-r", rev,
                          "--", root_file(path)], capture_output=True, cwd=root)
    if out.returncode:
        if b"No such path" in out.stderr or b"not found" in out.stderr.lower() or not out.stderr.strip():
            return None
        raise JJError(out.stderr.decode(errors="replace"))
    return out.stdout


def split_lines(data):
    return data.decode("utf-8", errors="surrogateescape").splitlines(keepends=True)


def line_blocks(repo, commit_id, max_files=150, max_bytes=1_000_000, jobs=DEFAULT_JOBS):
    """Changes of a single-parent commit as difflib blocks. The diff-editor helper recomputes exactly these
    blocks from the files jj hands it, so a selection made in the viewer maps 1:1 onto the edit."""
    import difflib
    import hashlib
    parents = jj(repo, "log", "--no-graph", "-r", f"{commit_id}-", "-T", 'commit_id ++ "\\n"').split()
    if len(parents) != 1:
        return {"error": "line selection needs a commit with exactly one parent"}
    parent = parents[0]
    files = changed_files(repo, commit_id)["files"][:max_files]

    def one(f):
        a = None if f["status"] == "added" else file_bytes(repo, parent, f.get("source") or f["path"])
        b = None if f["status"] == "removed" else file_bytes(repo, commit_id, f["path"])
        entry = {"path": f["path"], "status": f["status"], "sha_a": hashlib.sha1(a or b"").hexdigest(),
                 "sha_b": hashlib.sha1(b or b"").hexdigest()}
        if f["status"] in ("renamed", "copied") or (a and b"\x00" in a[:8192]) or (b and b"\x00" in b[:8192]) \
                or len(a or b"") + len(b or b"") > max_bytes:
            entry["whole_only"] = True
            return entry
        al, bl = split_lines(a or b""), split_lines(b or b"")
        blocks = []
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, al, bl, autojunk=False).get_opcodes():
            blocks.append({"tag": tag, "a": al[i1:i2], "b": bl[j1:j2]} if tag != "equal" else {"tag": tag, "n": i2 - i1, "a": al[i1:i2]})
        entry["blocks"] = blocks
        return entry

    with ThreadPoolExecutor(jobs) as pool:
        out = list(pool.map(one, files))
    return {"parent": parent, "files": out}


def file_texts(repo, base_rev, head_rev, files, max_file=2_000_000, max_total=40_000_000, jobs=DEFAULT_JOBS):
    """Base and head contents of changed files, for move detection in the page."""
    def one(f):
        status = f["status"]
        a = None if status == "added" else file_bytes(repo, base_rev, f.get("source") or f["path"])
        b = None if status == "removed" else file_bytes(repo, head_rev, f["path"])
        binary = any(x is not None and (b"\x00" in x[:8192] or len(x) > max_file) for x in (a, b))
        return {"path": f["path"], "oldPath": f.get("source"), "status": status, "binary": binary,
                "base": None if binary or a is None else a.decode("utf-8", errors="replace"),
                "head": None if binary or b is None else b.decode("utf-8", errors="replace")}
    with ThreadPoolExecutor(jobs) as pool:
        out = list(pool.map(one, files))
    total = 0
    for f in out:
        total += len(f["base"] or "") + len(f["head"] or "")
        if total > max_total:
            f["base"] = f["head"] = None
            f["binary"] = True
    return {"files": out}


def commit_texts(repo, commit_id):
    parents = jj(repo, "log", "--no-graph", "-r", f"{commit_id}-", "-T", 'commit_id ++ "\\n"').split()
    if len(parents) != 1:
        return {"error": "move detection needs a commit with exactly one parent", "files": []}
    files = changed_files(repo, commit_id, limit=400)["files"]
    out = file_texts(repo, parents[0], commit_id, files)
    out["base"] = parents[0]
    return out


def pair_texts(repo, a, b):
    files = [{"path": f["path"], "source": f["source"], "status": f["status"]} for f in pair_diff(repo, "diff", a, b)["files"][:400]]
    return file_texts(repo, a, b, files)


def file_list(repo, commit_id, limit=60_000):
    root = workspace_root(repo)
    out = jj(root, "file", "list", "-r", commit_id, tag="file list", cwd=root)
    paths = [p for p in out.splitlines() if p]
    return {"paths": paths[:limit], "total": len(paths)}


def annotate(repo, commit_id, path, max_lines=20_000):
    """jj file annotate: for every line the commit that last changed it."""
    root = workspace_root(repo)
    out = subprocess.run(["jj", "--no-pager", "--color=never", "--ignore-working-copy", "-R", root, "file", "annotate",
                          "-r", commit_id, "-T", 'commit.commit_id() ++ " " ++ original_line_number ++ " " ++ content', "--", path],
                         capture_output=True, cwd=root)
    if out.returncode:
        raise JJError(out.stderr.decode(errors="replace").strip())
    text = out.stdout.decode("utf-8", errors="replace")
    lines, ids, orig = [], [], []
    for raw in text.splitlines(keepends=True)[:max_lines]:
        cid, _, rest = raw.partition(" ")
        num, _, content = rest.partition(" ")
        lines.append(content.rstrip("\n"))
        ids.append(cid)
        orig.append(int(num) if num.isdigit() else 0)
    uniq = sorted(set(ids))
    index = {c: i for i, c in enumerate(uniq)}
    return {"commits": uniq, "lines": lines, "who": [index[c] for c in ids], "orig": orig}


def conflict_text(repo, commit_id, path, max_bytes=2_000_000):
    """The conflicted file with git-style markers (side 1, base, side 2), as jj materializes it."""
    root = workspace_root(repo)
    out = subprocess.run(["jj", "--no-pager", "--color=never", "--ignore-working-copy", "-R", root,
                          "--config", "ui.conflict-marker-style=git", "file", "show", "-r", commit_id, root_file(path)],
                         capture_output=True, cwd=root)
    if out.returncode:
        raise JJError(out.stderr.decode(errors="replace").strip())
    return {"text": out.stdout[:max_bytes].decode("utf-8", errors="replace"), "truncated": len(out.stdout) > max_bytes}


def stale_workspaces(repo, rows):
    """Workspaces whose files were last updated at an operation where their working-copy commit was a different one.
    Reads each workspace's working-copy state (no snapshot) and compares that commit with the current one."""
    def check(w):
        if w.get("current") or not w.get("root") or not Path(w["root"]).is_dir():
            return None
        try:
            info = jj(w["root"], "debug", "working-copy")
            m = re.search(r'Current operation: OperationId\("([0-9a-f]+)"\)', info)
            if not m:
                return None
            then = {}
            for line in jj(repo, "--at-op", m.group(1), "workspace", "list", "-T", WORKSPACE_TEMPLATE).splitlines():
                if line.strip():
                    name, target, _ = (json.loads(x) for x in line.split("\t"))
                    then[name] = target
            old = then.get(w["name"])
            if not old or old == w.get("target"):
                return False
            # A rewrite that kept the files (e.g. describe) does not leave the working copy stale.
            return bool(jj(repo, "diff", "--from", old, "--to", w["target"], "--summary").strip())
        except JJError:
            return None
    with ThreadPoolExecutor(4) as pool:
        for w, st in zip(rows, pool.map(check, rows)):
            w["stale"] = st
    return rows


def delta_ops(history):
    """Stores each operation after the first as the difference to the one before: consecutive operations
    usually differ in a handful of commits and bookmarks, so this shrinks long op histories a lot."""
    prev_v, prev_b = None, None
    for op in history:
        v, b = set(op["visible"]), {(n, i) for n, i in op["bm"]}
        if prev_v is not None:
            op["va"] = sorted(v - prev_v)
            op["vr"] = sorted(prev_v - v)
            op["ba"] = sorted([n, i] for n, i in b - prev_b)
            op["br"] = sorted([n, i] for n, i in prev_b - b)
            del op["visible"], op["bm"]
        prev_v, prev_b = v, b


def untracked_paths(repo):
    """Paths `jj status` lists as untracked in this workspace (snapshot.auto-track excludes them)."""
    root = workspace_root(repo)
    out = subprocess.run(["jj", "--no-pager", "--color=never", "-R", root, "status"], capture_output=True, text=True, cwd=root)
    paths, inside = [], False
    for line in out.stdout.splitlines():
        if line.startswith("Untracked paths:"):
            inside = True
            continue
        if inside:
            if line.startswith("? "):
                paths.append(line[2:])
            elif not line.startswith(" "):
                inside = False
    return paths


def similarity(a, b):
    """Line similarity of two file contents in [0, 1], like git's rename score."""
    import difflib
    if a is None or b is None:
        return 0.0
    la, lb = split_lines(a), split_lines(b)
    if not la and not lb:
        return 1.0
    sm = difflib.SequenceMatcher(None, la, lb, autojunk=False)
    if sm.real_quick_ratio() < RENAME_THRESHOLD or sm.quick_ratio() < RENAME_THRESHOLD:
        return sm.quick_ratio() * 0.5
    return sm.ratio()


RENAME_THRESHOLD = 0.5


def rename_partner(repo, commit_id, path, direction, files=None):
    """In `commit_id`, the file that `path` was renamed from (direction "back") or to ("fwd"), also when jj did not
    detect it because the content changed a bit. Returns (other_path, score) or (None, 0)."""
    files = files if files is not None else changed_files(repo, commit_id)["files"]
    me = next((f for f in files if f["path"] == path or (direction == "fwd" and f.get("source") == path)), None)
    if me and me["status"] in ("renamed", "copied") and me.get("source"):
        parents = jj(repo, "log", "--no-graph", "-r", f"{commit_id}-", "-T", 'commit_id ++ "\\n"').split()
        score = similarity(file_bytes(repo, parents[0], me["source"]), file_bytes(repo, commit_id, me["path"])) if len(parents) == 1 else 1.0
        return (me["source"], score) if direction == "back" else (me["path"], score)
    want = "removed" if direction == "back" else "added"
    if not me or me["status"] != ("added" if direction == "back" else "removed"):
        return None, 0.0
    cands = [f["path"] for f in files if f["status"] == want]
    if not cands:
        return None, 0.0
    parents = jj(repo, "log", "--no-graph", "-r", f"{commit_id}-", "-T", 'commit_id ++ "\\n"').split()
    if len(parents) != 1:
        return None, 0.0
    if direction == "back":
        mine = file_bytes(repo, commit_id, path)
        scored = [(c, similarity(mine, file_bytes(repo, parents[0], c))) for c in cands[:40]]
    else:
        mine = file_bytes(repo, parents[0], path)
        scored = [(c, similarity(mine, file_bytes(repo, commit_id, c))) for c in cands[:40]]
    best = max(scored, key=lambda x: x[1], default=(None, 0.0))
    return best if best[1] >= RENAME_THRESHOLD else (None, 0.0)


def follow_file(repo, commit_id, path, max_commits=400, max_renames=25):
    """History of a file through renames, in both directions from `commit_id`: every commit that touched it, with the
    name it had there, and the rename steps (including renames with edits that jj itself reports as add + delete)."""
    root = workspace_root(repo)
    out, renames, seen = [], [], set()

    def touching(revset):
        text = jj(root, "log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"', cwd=root)
        return [c for c in text.split() if c]

    # backwards: ancestors that touch the current name; at the oldest one, check whether the file came from a rename
    cur, rev = path, commit_id
    for _ in range(max_renames + 1):
        commits = touching(f"::{rev} & files({root_file(cur)})")
        commits = [c for c in commits if c not in seen][:max_commits - len(out)]
        for c in commits:
            seen.add(c)
            out.append({"commit": c, "path": cur})
        if not commits or len(out) >= max_commits:
            break
        oldest = commits[-1]
        other, score = rename_partner(repo, oldest, cur, "back")
        if not other:
            break
        renames.append({"commit": oldest, "from": other, "to": cur, "score": round(score, 3)})
        cur, rev = other, f"{oldest}-"
    # forwards: descendants; where the file disappears, check whether it lives on under another name
    cur, rev = path, commit_id
    for _ in range(max_renames + 1):
        commits = touching(f"{rev}:: & files({root_file(cur)}) ~ {rev}")
        commits.reverse()
        new = [c for c in commits if c not in seen][:max_commits - len(out)]
        for c in new:
            seen.add(c)
            out.append({"commit": c, "path": cur})
        if not new or len(out) >= max_commits:
            break
        moved = None
        for c in new:
            other, score = rename_partner(repo, c, cur, "fwd")
            if other:
                moved = (c, other, score)
                break
        if not moved:
            break
        c, other, score = moved
        renames.append({"commit": c, "from": cur, "to": other, "score": round(score, 3)})
        for e in out:
            if e["commit"] == c:
                e["path"] = other
        cur, rev = other, c
    return {"path": path, "commits": out, "renames": renames, "truncated": len(out) >= max_commits}


def op_details(repo, op_id, max_bytes=200_000):
    out = jj(repo, "op", "show", op_id, "--no-graph", "--summary", tag="op show")
    return {"text": out[:max_bytes], "truncated": len(out) > max_bytes}


def file_diff(repo, commit_id, path, max_bytes=200_000):
    """Git-style diff of one file in one commit."""
    root = workspace_root(repo)
    out = jj(root, "diff", "--git", "-r", commit_id, "--", root_file(path), tag="file diff", cwd=root)
    return {"diff": out[:max_bytes], "truncated": len(out) > max_bytes}


def current_op(repo):
    return jj(repo, "op", "log", "--no-graph", "--limit", "1", "-T", 'id.short(12)').strip()


def jj_user(repo):
    user = {}
    for key in ("name", "email"):
        cmd = ["jj", "--no-pager", "--ignore-working-copy"] + (["-R", repo] if repo else []) + ["config", "get", f"user.{key}"]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            user[key] = out.stdout.strip()
    return user


def export(repo=None, revisions=None, window=80, ops=0, with_evolog=True, snapshot=True, cache=None,
           jobs=DEFAULT_JOBS, evolog_depth=DEFAULT_EVOLOG_DEPTH, evolog_budget=30.0):
    """Build the jj-orbit document. `cache` (a dict kept by the caller) makes repeated exports incremental:
    the log at a past operation and the evolog of a commit never change, so both are reused."""
    cache = {} if cache is None else cache
    # per-op rows depend on the revset (window), so a smaller window must not reuse rows read with a larger one
    revset_key = revisions or DEFAULT_REVSET.format(window=window)
    if cache.get("op_rows_revset") != revset_key:
        cache["op_rows"] = {}
        cache["op_rows_revset"] = revset_key
    op_rows = cache["op_rows"]
    evo_cache = cache.setdefault("evolog", {})
    warnings = []

    revset = revisions or DEFAULT_REVSET.format(window=window)
    del PROFILE[:]
    stale = False
    if snapshot:
        try:
            log_commits(repo, "present(@)", snapshot=True, tag="snapshot working copy")
        except JJError as e:
            if "working copy is stale" not in str(e):
                raise
            stale = True
    side = ThreadPoolExecutor(4)
    f_ws = side.submit(workspaces, repo)
    f_trunk = side.submit(jj, repo, "log", "--no-graph", "-r", "present(trunk())", "-T", 'commit_id ++ "\\n"', tag="trunk")
    f_ops = side.submit(op_history, repo, ops) if ops > 0 else side.submit(current_op, repo)
    if "user" not in cache:
        cache["user"] = side.submit(jj_user, repo)
    if "version" not in cache:
        cache["version"] = side.submit(lambda: subprocess.run(["jj", "--version"], capture_output=True, text=True).stdout.strip())
    bms = bookmarks(repo)
    extra = divergence_revset(bms)
    full_revset = f"({revset}) | {extra}" if extra else revset

    commits = log_commits(repo, full_revset, tag="log (revset)")
    evo = evolog(repo, commits, evo_cache, warnings, evolog_depth, jobs, evolog_budget) if with_evolog else {}
    by_id = {c["id"]: c for c in commits}

    history = []
    if ops > 0:
        readable = []
        listed = f_ops.result()
        missing = [o["full"] for o in listed if o["full"] not in op_rows]

        def at_op(full):
            try:
                return full, log_commits(repo, revset, at_op=full, tag="op history (new ops)"), None
            except JJError as e:
                return full, None, str(e).strip().splitlines()[-1]

        with ThreadPoolExecutor(jobs) as pool:
            for full, rows, why in pool.map(at_op, missing):
                op_rows[full] = rows
                if why:
                    op_rows[full + ":why"] = why
        for op in listed:
            full = op.pop("full")
            rows = op_rows[full]
            if rows is None:
                warnings.append(f"op {op['id']} skipped: {op_rows.get(full + ':why', 'unreadable')}")
                continue
            op["full"] = full
            readable.append(op)
        history = readable
        for op in history:
            rows = op_rows[op.pop("full")]
            op["visible"] = [r["id"] for r in rows]
            op["wc"] = next((r["id"] for r in rows if r["wc"]), None)
            op["bm"] = [[name, r["id"]] for r in rows for name in r["lb"] + r["rb"] + r["tags"]]
            for r in rows:
                if r["id"] not in by_id:
                    g = copy.deepcopy(r)
                    g["wc"] = False
                    g["gone"] = True
                    by_id[g["id"]] = g
                    commits.append(g)

    keep_ops = {o["id"] for o in history} | {w.split()[1] for w in warnings if w.startswith("op ")}
    for k in [k for k in op_rows if k[:12] not in keep_ops]:
        del op_rows[k]
    current = {c["id"] for c in commits}
    for k in [k for k in evo_cache if k not in current]:
        del evo_cache[k]

    connect_elided(repo, full_revset, commits, warnings, jobs)

    trunk = f_trunk.result().strip()
    for key in ("user", "version"):
        if hasattr(cache[key], "result"):
            cache[key] = cache[key].result()
    version, user = cache["version"], cache["user"]
    spaces = f_ws.result()
    current = history[-1]["id"] if history else f_ops.result()
    side.shutdown()

    index = {c["id"]: i for i, c in enumerate(commits)}
    for op in history:
        op["visible"] = [index[x] for x in op["visible"]]
        op["wc"] = index.get(op["wc"])
        op["bm"] = [[name, index[i]] for name, i in op["bm"]]
    delta_ops(history)

    return {
        "meta": {
            "repo": repo or ".",
            "revset": revset,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "jj": version,
            "op": current,
            "trunk": None if trunk in ("", ROOT_COMMIT) else trunk,
            "user": user,
            "warnings": warnings[:50],
            "stale": stale,
            "untracked": untracked_paths(repo) if snapshot and not stale else [],
            "window": window if not revisions else None,
            "more_revs": more_revisions(repo, window) if not revisions else False,
            "ops_limit": ops,
            "ops_delta": 1,
            "more_ops": ops > 0 and len(history) >= ops and more_operations(repo, ops),
            "evolog": "eager" if with_evolog else "off",
        },
        "commits": commits,
        "bookmarks": bms,
        "workspaces": spaces,
        "evolog": evo,
        "ops": history,
    }


def profile_report(total=None):
    groups = {}
    for tag, secs, size in PROFILE:
        g = groups.setdefault(tag, [0, 0.0, 0, 0.0])
        g[0] += 1
        g[1] += secs
        g[2] += size
        g[3] = max(g[3], secs)
    lines = [f"{'jj call':24s} {'calls':>5s} {'sum s':>7s} {'max s':>6s} {'output':>9s}"]
    for tag, (n, secs, size, mx) in sorted(groups.items(), key=lambda x: -x[1][1]):
        lines.append(f"{tag:24s} {n:5d} {secs:7.2f} {mx:6.2f} {size / 1024:7.0f} KB")
    if total is not None:
        lines.append(f"wall time {total:.2f} s (calls partly run in parallel)")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", action="version", version=f"jj-orbit {VERSION}")
    ap.add_argument("-R", "--repository", help="path to the jj repo (default: cwd)")
    ap.add_argument("-r", "--revisions", help="revset to export (default: mutable work plus a trunk window)")
    ap.add_argument("--window", type=int, default=80, help="trunk commits to include with the default revset")
    ap.add_argument("--ops", type=int, default=0, help="include the last N operations for the op-log scrubber")
    ap.add_argument("--no-evolog", action="store_true", help="skip evolution history")
    ap.add_argument("--evolog-depth", type=int, default=DEFAULT_EVOLOG_DEPTH, help="earlier versions per commit (0: all)")
    ap.add_argument("--evolog-budget", type=float, default=30.0, help="seconds for reading damaged evologs one by one")
    ap.add_argument("-j", "--jobs", type=int, default=DEFAULT_JOBS, help="parallel jj processes for op history")
    ap.add_argument("--no-snapshot", action="store_true", help="do not snapshot the working copy first")
    ap.add_argument("-o", "--output", default="jj-orbit.json", help="output file ('-' for stdout)")
    ap.add_argument("--profile", action="store_true", help="print where the time goes")
    args = ap.parse_args()

    t0 = time.monotonic()
    try:
        data = export(args.repository, args.revisions, args.window, args.ops, not args.no_evolog, not args.no_snapshot,
                      jobs=args.jobs, evolog_depth=args.evolog_depth, evolog_budget=args.evolog_budget)
    except JJError as e:
        sys.exit(str(e))

    text = json.dumps(data, separators=(",", ":"))
    if args.output == "-":
        sys.stdout.write(text)
    else:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{len(data['commits'])} commits, {sum(len(v) for v in data['evolog'].values())} evolog entries, "
              f"{len(data['ops'])} ops -> {args.output}", file=sys.stderr)
    for w in data["meta"]["warnings"]:
        print("warning:", w, file=sys.stderr)
    if args.profile:
        mutable = sum(1 for c in data["commits"] if not c["immutable"] and not c.get("gone"))
        print(f"\n{len(data['commits'])} commits exported, {mutable} of them mutable", file=sys.stderr)
        print(profile_report(time.monotonic() - t0), file=sys.stderr)


if __name__ == "__main__":
    main()
