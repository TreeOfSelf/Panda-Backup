#!/usr/bin/env python3
"""Panda Backup storage maintenance - runs on the storage server from cron.

Clients can only append archives (rrsync -wo -no-del -no-overwrite), so
everything that reads or deletes happens here:

  * verify new archives (sidecar sha256 + full decompress/list)
  * quarantine archives that fail verification
  * prune by retention.json, never deleting anything younger than the
    retention window so a flood of junk uploads cannot push out good backups
  * spot-check older archives so restores are known to work
  * report stale folders and empty archives

Prints nothing unless there is a problem, so cron mail (MAILTO) only fires on
problems. Full status goes to status.json / status.txt next to this script.
"""

import fcntl
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, "servers")
PANDA = os.path.join(HOME, "panda")
MANIFEST = os.path.join(PANDA, "manifest.json")
RETENTION = os.path.join(PANDA, "retention.json")
QUARANTINE = os.path.join(PANDA, "quarantine")
LOG = os.path.join(PANDA, "storage.log")
SUFFIXES = (".tar.bz2", ".tar.xz", ".tar.zst")
SETTLE_SECONDS = 120              # ignore files still being written
SPOT_CHECK_BYTES = 5 * 1024**3    # re-verify up to this much old data per run
DAY = 86400

problems = []
DRY_RUN = "--dry-run" in sys.argv  # report only: nothing is moved, deleted or saved


def log(msg):
    line = time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg
    with open(LOG, "a") as f:
        f.write(line + "\n")


def problem(msg):
    problems.append(msg)
    log("PROBLEM: " + msg)


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(path):
    """Return (ok, entries, error). Lists the whole archive, which fully decompresses it."""
    sidecar = path + ".sha256"
    if os.path.exists(sidecar):
        with open(sidecar) as f:
            expected = f.read().split()[0]
        if sha256(path) != expected:
            return False, 0, "checksum mismatch"
    proc = subprocess.run(["nice", "-n", "19", "tar", "-tf", path],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        return False, 0, proc.stderr.strip()[-300:]
    entries = [l for l in proc.stdout.splitlines() if l and l != "./"]
    return True, len(entries), None


def scan():
    """Yield (relative folder 'type/name/backup/slot', filename, full path)."""
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT)
        parts = rel.split(os.sep)
        if len(parts) != 4 or parts[3] not in ("short", "long"):
            continue
        if parts[0].startswith("_") and not os.environ.get("PANDA_INCLUDE_TEST"):
            continue
        for fn in filenames:
            if fn.startswith(".") or not fn.endswith(SUFFIXES):
                continue
            yield rel, fn, os.path.join(dirpath, fn)


def quarantine(path, rel, fn, reason):
    if DRY_RUN:
        problem(f"[dry-run] would quarantine {rel}/{fn}: {reason}")
        return
    dest_dir = os.path.join(QUARANTINE, rel)
    os.makedirs(dest_dir, exist_ok=True)
    shutil.move(path, os.path.join(dest_dir, fn))
    if os.path.exists(path + ".sha256"):
        shutil.move(path + ".sha256", os.path.join(dest_dir, fn + ".sha256"))
    problem(f"quarantined {rel}/{fn}: {reason}")


def main():
    os.makedirs(PANDA, exist_ok=True)
    if DRY_RUN:
        global LOG
        LOG = os.path.join(PANDA, "dry-run.log")
    lock = open(os.path.join(PANDA, ".lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # previous run still going

    now = time.time()
    first_run = not os.path.exists(MANIFEST)
    manifest = load_json(MANIFEST, {})
    retention = load_json(RETENTION, {})
    seen = set()

    # 1. Register and verify new files
    for rel, fn, path in scan():
        key = f"{rel}/{fn}"
        seen.add(key)
        st = os.stat(path)
        entry = manifest.get(key)
        if entry is None:
            if first_run:
                # Existing history: trust its age, verify later via spot checks
                manifest[key] = {"first_seen": st.st_mtime, "size": st.st_size, "verified": None}
                continue
            if now - st.st_mtime < SETTLE_SECONDS:
                continue
            ok, entries, err = verify(path)
            if not ok:
                quarantine(path, rel, fn, err)
                continue
            manifest[key] = {"first_seen": now, "size": st.st_size, "verified": now, "entries": entries}
            log(f"verified {key} ({entries} entries, {st.st_size} bytes)")
            if entries == 0:
                problem(f"empty archive {key} - check that server's files list")
        elif entry["size"] != st.st_size:
            quarantine(path, rel, fn, "size changed after upload")
            seen.discard(key)

    for key in list(manifest):
        if key not in seen:
            del manifest[key]

    # 2. Spot-check old archives (oldest verification first)
    budget = 0 if first_run else SPOT_CHECK_BYTES
    candidates = sorted(manifest.items(), key=lambda kv: (kv[1].get("verified") or 0, random.random()))
    for key, entry in candidates:
        if budget <= 0 or (entry.get("verified") or 0) > now - 30 * DAY:
            break
        path = os.path.join(ROOT, key)
        budget -= entry["size"]
        ok, entries, err = verify(path)
        if ok:
            entry["verified"], entry["entries"] = now, entries
            log(f"spot-check ok {key}")
        else:
            rel, fn = key.rsplit("/", 1)
            quarantine(path, rel, fn, "spot-check failed: " + str(err))
            del manifest[key]

    # 3. Retention
    folders = {}
    for key, entry in manifest.items():
        rel, fn = key.rsplit("/", 1)
        folders.setdefault(rel, []).append((entry["first_seen"], fn))

    for rel, files in folders.items():
        type_name_backup, slot = rel.rsplit("/", 1)
        rule = retention.get(type_name_backup)
        if not rule:
            continue  # unknown folders are never pruned
        limit = rule.get(slot, 0)
        if not limit:
            continue
        # Minimum age before anything may be deleted: the time it takes legitimate backups to fill the limit
        window = (limit * max(1, rule.get("shortFreq", 1)) + 2) * DAY if slot == "short" else (limit * 31 + 5) * DAY
        files.sort(reverse=True)
        for first_seen, fn in files[limit:]:
            if now - first_seen < window:
                continue
            path = os.path.join(ROOT, rel, fn)
            log(f"{'[dry-run] would prune' if DRY_RUN else 'pruning'} {rel}/{fn}")
            if DRY_RUN:
                continue
            for p in (path, path + ".sha256"):
                if os.path.exists(p):
                    os.remove(p)
            del manifest[f"{rel}/{fn}"]

    # 4. Staleness report
    status = {}
    for type_name_backup, rule in retention.items():
        for slot in ("short", "long"):
            if not rule.get("expect_" + slot):
                continue
            files = folders.get(f"{type_name_backup}/{slot}", [])
            newest = max((f[0] for f in files), default=0)
            age_days = (now - newest) / DAY if newest else None
            status[f"{type_name_backup}/{slot}"] = {"count": len(files), "newest_age_days": age_days}
            max_age = (max(1, rule.get("shortFreq", 1)) + 1.5) if slot == "short" else 33
            # Unchanged content is not re-uploaded, so stale is only a hint
            if rule.get("alert_stale") and (age_days is None or age_days > max_age):
                problem(f"no new {slot} backup for {type_name_backup} in {age_days and round(age_days, 1)} days")

    if DRY_RUN:
        print("\n".join(problems) or "[dry-run] no problems")
        return
    save_json(MANIFEST, manifest)
    save_json(os.path.join(PANDA, "status.json"), {"generated": now, "folders": status, "problems": problems})
    with open(os.path.join(PANDA, "status.txt"), "w") as f:
        f.write(time.strftime("Generated %Y-%m-%d %H:%M:%S\n\n"))
        f.write("\n".join(problems) if problems else "No problems.\n")

    if problems:
        print("Panda Backup storage problems:\n" + "\n".join(" - " + p for p in problems))


if __name__ == "__main__":
    main()
