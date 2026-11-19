"""Offline materials -> the existing public MigLoop skills; never invent DSH events."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for data in iter(lambda: f.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()


def command(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def prepare(config, output, runtime):
    c, rt = read(config), read(runtime)
    output = Path(output).absolute()
    source = Path(c["materials"]).resolve()
    if output.exists() or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("New output must be separate from materials")
    if not source.is_dir() or source.is_symlink():
        raise ValueError("Materials must be a real directory")
    output.mkdir(parents=True, mode=0o700)
    shutil.copytree(rt["skills"], output / "skills", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    materials = output / "materials"
    files, native_sources, originals = [], [], {}
    if c.get("format") == "dsh":
        sys.path.insert(0, str(Path(rt["migloop"]["directory"]) / "src"))
        from migloop.adapters.dsh_source import freeze_tree, read_header, descendants
        materials.mkdir()
        for session in c.get("sessions", []):
            selected = Path(session).resolve()
            if not selected.is_relative_to(source):
                raise ValueError("Selected DSH generation is outside the explicit sessions root")
            head = read_header(str(selected))
            headers = [head, *(h for h, _ in descendants(str(source), head["id"]))]
            if any(not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", str(h.get("id", ""))) for h in headers):
                raise ValueError("Unsafe native DSH session identity")
            native_sources.append(freeze_tree(str(Path(session).resolve()), str(materials), root=str(source)))
        if not c.get("sessions"):
            raise ValueError("DSH input requires explicit session generation paths")
    elif c.get("format") in {"claude", "codex", "deveco", "a2h-export/4", "native-pool"}:
        materials.mkdir()
        total = 0
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("Materials cannot contain links")
            if not path.is_file():
                continue
            relative = path.relative_to(source)
            if any(p.startswith(".") for p in relative.parts):
                continue
            total += path.stat().st_size
            if total > c.get("maxBytes", 4 * 1024**3):
                raise ValueError("Material pool exceeds byte budget")
            target = materials / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            before = sha(path)
            shutil.copyfile(path, target)
            if sha(target) != before or sha(path) != before:
                raise ValueError("Materials changed while freezing")
    else:
        raise ValueError("Explicit supported native format is required")
    # A flywheel export can carry original DSH generations under arbitrary
    # filenames. Preserve those bytes separately and use the public adapter's
    # lossless event envelope for the shared inquiry kernel.
    if c.get("format") != "dsh":
        sys.path.insert(0, str(Path(rt["migloop"]["directory"]) / "src"))
        from migloop.adapters.dsh_source import read_session, frozen_rows
        for path in sorted(materials.rglob("*.jsonl")):
            with path.open("r", encoding="utf-8") as stream:
                first = stream.readline(1024 * 1024)
            try:
                header = json.loads(first)
            except ValueError:
                continue
            if not isinstance(header, dict) or header.get("type") != "session" or header.get("version") != 4:
                continue
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", str(header.get("id", ""))):
                raise ValueError("Unsafe native DSH session identity")
            relative = path.relative_to(materials)
            scope = relative.parent.parent if re.fullmatch(r"session(?:\.v\d+)?\.jsonl", relative.name) else relative.parent
            original = output / "originals" / scope / "dsh" / header["id"] / "session.v4.jsonl"
            if original.exists():
                raise ValueError("Multiple native generations for one session in a scope require an explicit generation selection")
            original.parent.mkdir(parents=True, exist_ok=True)
            path.rename(original)
            native_header, events, generation = read_session(str(original))
            with path.open("w", encoding="utf-8", newline="\n") as stream:
                for row in frozen_rows(native_header, events, generation):
                    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            originals[relative.as_posix()] = {"originalFile": original.relative_to(output).as_posix(), "originalSha256": sha(original), "adapter": "dsh-events/1", "nativeSessionId": native_header["id"]}
    for path in sorted(materials.rglob("*")):
        if path.is_file():
            name = path.relative_to(materials).as_posix()
            files.append({"file": name, "bytes": path.stat().st_size, "sha256": sha(path), **originals.get(name, {})})
    if not any(f["file"].endswith(".jsonl") for f in files):
        raise ValueError("No native transcript files in material pool")
    triage = output / "skills/migloop-repair-triage/scripts/triage.py"
    local_id = c.get("migrationId") or "offline-" + hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:20]
    write(output / "migration-metadata.json", {"migration": {"id": local_id, "server_session_id": c.get("serverSessionId"), "project": c.get("app", source.name)}})
    command([sys.executable, triage, "metadata", "--pool", materials, "--server-metadata", output / "migration-metadata.json", "--out", output / "metadata.json"])
    write(output / "materials-manifest.json", {"schemaVersion": "migloop.offline-materials/1", "format": c["format"], "files": files, "nativeSources": native_sources})
    memory = output / "skills/migloop-memory-maintain/scripts/memory.py"
    if c.get("baseStore"):
        base = Path(c["baseStore"])
        if base.is_symlink() or not base.is_dir() or any(p.is_symlink() for p in base.rglob("*")):
            raise ValueError("Base store must be an ordinary directory without links")
        original_head = sha(base / "HEAD.json")
        shutil.copytree(base, output / "store", ignore=shutil.ignore_patterns(".publish.lock"))
        if sha(base / "HEAD.json") != original_head or sha(output / "store/HEAD.json") != original_head:
            raise ValueError("Base store changed during freezing")
    else:
        command([sys.executable, memory, "init", "--store", output / "store"])
    revision = read(output / "store/HEAD.json")["revision"]
    command([sys.executable, memory, "export", "--store", output / "store", "--out", output / "base-memory"])
    job = {"kind": "session", "worker_host": "dsh", "app": c.get("app", source.name), "migration_id": c.get("serverSessionId"), "local_migration_id": local_id,
           "run": str(output), "store": str(output / "store"), "materials": str(materials), "python": sys.executable,
           "skill": str(output / "skills/migloop-session-to-memory/SKILL.md"), "memory_library_revision": revision,
           "current_library_reading": "base-memory/index.md", "server_metadata": str(output / "migration-metadata.json"), "generation_root": c.get("generationRoot"), "repair_roots": c.get("repairRoots", []),
           "boundary_evidence": c.get("boundaryEvidence", {}), "holdout_apps": c.get("holdoutApps", []), "source_format": c["format"], "scope_note": c.get("scope", ""), "max_issues": c.get("maxIssues", 1)}
    if c.get("checkpointRepository"):
        repo = str(Path(c["checkpointRepository"]).resolve())
        generation = command(["git", "--git-dir=" + repo, "rev-parse", "--verify", "--end-of-options", c["generationRef"] + "^{commit}"])
        final = command(["git", "--git-dir=" + repo, "rev-parse", "--verify", "--end-of-options", c["finalRef"] + "^{commit}"])
        patch = subprocess.check_output(["git", "--git-dir=" + repo, "diff", "--no-ext-diff", "--no-textconv", "--binary", generation, final])
        (output / "evidence").mkdir()
        (output / "evidence/retained-application.patch").write_bytes(patch)
        job.update(checkpoint_repository_read_only=repo, generation_checkpoint=generation, final_checkpoint=final, retained_change_evidence="evidence/retained-application.patch")
    write(output / "job.json", job)
    (output / "CLAUDE.md").write_text("# Offline Memory distillation job\n\nRead job.json, then the exact skill at its skill path. Honor job.scope_note and max_issues; do not claim full migration coverage for this bounded pilot. Follow triage → independent card subagents → memory maintain. Historical materials and checkpoint repository are read-only. Work only in this run. Do not use neighboring experiments or held-out apps. Boundaries missing from the job must be established from original evidence; never invent them. Every issue needs an independent subagent; give each subagent its dispatch job path and the absolute skills/migloop-build-cards/SKILL.md path. Read relevant evidence spans, never transmit an entire source archive. Export memory with --link-cards to memory/index.md. Deliver REPORT.md and completion.json with status, reason, tasks, cards, revision and memory_index. A blocked/partial delivery is not an accepted experiment.\n", encoding="utf-8")
    return {"prepared": str(output), "materials": len(files), "start_revision": revision, "worker_host": "dsh", "local_migration_id": local_id}


def check(run):
    run = Path(run).resolve()
    sys.path.insert(0, str(run / "skills/migloop-memory-maintain/scripts/_runtime"))
    from memorylib.registry import Memory, validate_case
    from memorylib.card_contract import require_valid_card
    job, completion = read(run / "job.json"), read(run / "completion.json")
    if completion.get("status") != "completed" or not str(completion.get("reason", "")).strip() or not (run / "REPORT.md").is_file():
        raise ValueError("A completed delivery with reason and REPORT.md is required")
    def contained(name):
        path = (run / name).resolve()
        if not path.is_relative_to(run) or path.is_symlink():
            raise ValueError("Delivery path escapes the run")
        return path
    import yaml
    tasks = yaml.safe_load(contained(completion.get("tasks", "repair-tasks.yaml")).read_text(encoding="utf-8"))
    if not isinstance(tasks.get("issues"), list):
        raise ValueError("Missing explicit triage issues")
    if not tasks["issues"] or completion.get("unresolved_jobs"):
        raise ValueError("A completed optimization needs at least one issue and no unresolved jobs")
    store = Memory(run / "store"); snapshot = store.current()
    cards = completion.get("cards", [])
    if not cards:
        raise ValueError("No completed cards; no memory improvement to evaluate")
    seen, jobs = set(), set()
    for value in cards:
        card = read(contained(value)); validate_case(card); require_valid_card(card)
        if card.get("migration_key") not in {job["local_migration_id"], job["materials"], job.get("migration_id")}:
            raise ValueError("Card belongs to another frozen material pool")
        if card["id"] in seen or snapshot["cases"].get(card["id"], {}).get("revision") != card["revision"]:
            raise ValueError("Card is duplicate or not ingested at this exact revision")
        seen.add(card["id"])
        if not card.get("job") or card["job"] in jobs:
            raise ValueError("Cards need distinct dispatched job identities")
        jobs.add(card["job"])
    dispatch = read(run / "dispatch/jobs.json")
    expected = {item["id"] for item in dispatch["jobs"]}
    if len(expected) != len(tasks["issues"]):
        raise ValueError("Triage and dispatch job count mismatch")
    for exclusion in completion.get("excluded_jobs", []):
        if not exclusion.get("reason") or exclusion.get("job") in jobs or not contained(exclusion.get("outcome", "")).is_file():
            raise ValueError("Excluded job needs a distinct ID, reason and existing outcome")
        jobs.add(exclusion["job"])
    if jobs != expected:
        raise ValueError("Some dispatched jobs are missing or unknown")
    index = contained(completion["memory_index"])
    if index != run / "memory/index.md":
        raise ValueError("Export this experiment's reading pack to memory/index.md")
    if completion.get("revision") != snapshot["revision"]:
        raise ValueError("Completion does not match current memory revision")
    manifest = read(index.parent / "manifest.json")
    if manifest.get("memory_revision") != snapshot["revision"] or "index.md" not in manifest.get("files", {}):
        raise ValueError("Reading package is not bound to the store revision")
    declared = set(manifest["files"]) | {"manifest.json"}
    actual = set()
    for path in index.parent.rglob("*"):
        if path.is_symlink():
            raise ValueError("Reading package cannot contain links")
        if path.is_file():
            name = path.relative_to(index.parent).as_posix()
            actual.add(name)
            if name != "manifest.json" and sha(path) != manifest["files"].get(name):
                raise ValueError("Reading package hash mismatch")
    if actual != declared:
        raise ValueError("Reading package has undeclared or missing files")
    result = {"ok": True, "revision": snapshot["revision"], "card_count": len(cards), "index": str(index), "source_format": job["source_format"]}
    write(run / "delivery-check.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("action", choices=["prepare", "check"])
    parser.add_argument("--config"); parser.add_argument("--out"); parser.add_argument("--runtime"); parser.add_argument("--run")
    a = parser.parse_args()
    try:
        result = prepare(a.config, a.out, a.runtime) if a.action == "prepare" else check(a.run)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
