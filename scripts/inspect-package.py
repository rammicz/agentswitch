"""Inspect an npm tarball without extracting any entries (Python standard library)."""
import json
import pathlib
import sys
import tarfile

entries = []
seen = set()
metadata = None
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        path = pathlib.PurePosixPath(member.name)
        if (
            not member.isfile()
            or member.name in seen
            or "\\" in member.name
            or path.is_absolute()
            or ".." in path.parts
            or path.parts[0] != "package"
            or len(path.parts) < 2
            or str(path) != member.name
        ):
            raise ValueError("Unexpected archive entry: " + member.name)
        seen.add(member.name)
        entries.append({"path": str(path.relative_to("package")), "size": member.size, "mode": member.mode})
        if member.name == "package/package.json":
            if member.size > 65536:
                raise ValueError("Package metadata is too large")
            metadata = json.load(archive.extractfile(member))
        if member.name == "package/dist/cli.js":
            # npm installs declared bin targets as executable, even when packed as 0644.
            if archive.extractfile(member).read(20) != b"#!/usr/bin/env node\n":
                raise ValueError("Archived CLI has no Node shebang")
if metadata is None:
    raise ValueError("Missing archived package metadata")
print(json.dumps({"entries": entries, "package": metadata}, indent=2))
