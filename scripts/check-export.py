#!/usr/bin/env python3
"""Parse-check the notebooks the exporter produces.

The golden files catch *changes*; this catches *invalidity*, which they cannot.

Three passes, in increasing order of what they need installed:

1. **Syntax.** Every code cell must parse. If any cell does not, the later passes are skipped
   — a cell that failed to parse binds unknown names, so carrying on reports every name in the
   notebook as undefined and buries the one real error.

2. **Undefined names.** Cells run top to bottom, so a name used in cell 7 must have been bound
   by cell 6. Catches a typo'd variable and a call whose import nobody declared.

3. **Attribute resolution**, and this is the pass that earns the script. The bug that motivated
   it was `import navis` followed by `navis.interfaces.neuprint.fetch_skeletons(...)` — valid
   syntax, `navis` a perfectly well-bound name, and an AttributeError at runtime because the
   package root does not import `interfaces`. Nothing static catches that; you have to import
   the module and look. So this pass runs only where the libraries are importable and is
   skipped with a notice where they are not, which keeps the script useful in a bare CI
   container without pretending it checked something it did not.

Nothing is ever executed: that would need a neuPrint token and a network.

    python3 scripts/check-export.py [--strict] [notebook.ipynb ...]
"""

from __future__ import annotations

import ast
import builtins
import importlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "src" / "export" / "python" / "__fixtures__"


def code_cells(notebook: dict) -> list[tuple[int, str]]:
    return [
        (i, "".join(cell["source"]))
        for i, cell in enumerate(notebook["cells"])
        if cell["cell_type"] == "code"
    ]


def syntax_problems(cells: list[tuple[int, str]]) -> list[str]:
    problems = []
    for index, source in cells:
        try:
            ast.parse(source)
        except SyntaxError as err:
            line = source.split("\n")[err.lineno - 1] if err.lineno else ""
            problems.append(f"cell {index}: {err.msg} (line {err.lineno})\n      {line.strip()}")
    return problems


def add_arg_names(args: ast.arguments, bound: set[str]) -> None:
    for a in [*args.args, *args.posonlyargs, *args.kwonlyargs]:
        bound.add(a.arg)
    for a in (args.vararg, args.kwarg):
        if a:
            bound.add(a.arg)


def collect_bindings(tree: ast.AST, bound: set[str]) -> None:
    """Every name this tree binds, however it binds it."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            bound.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            bound.add(node.name)
            add_arg_names(node.args, bound)
        elif isinstance(node, ast.ClassDef):
            bound.add(node.name)
        elif isinstance(node, ast.Lambda):
            add_arg_names(node.args, bound)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, ast.Global):
            bound.update(node.names)


def undefined_names(cells: list[tuple[int, str]]) -> list[str]:
    bound = set(dir(builtins)) | {"__builtins__", "_"}
    used: list[tuple[int, str, int]] = []

    for index, source in cells:
        tree = ast.parse(source)
        collect_bindings(tree, bound)
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and not isinstance(node.ctx, ast.Store):
                used.append((index, node.id, node.lineno))

    seen = set()
    problems = []
    for index, name, lineno in used:
        if name in bound or (index, name) in seen:
            continue
        seen.add((index, name))
        problems.append(f"cell {index} line {lineno}: undefined name {name!r}")
    return problems


def dotted(node: ast.Attribute) -> str | None:
    """`a.b.c` as a string, or None when the base is not a plain name."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def attribute_problems(cells: list[tuple[int, str]]) -> tuple[list[str], list[str]]:
    """Resolve `module.a.b` against the real module. Returns (problems, skipped modules)."""
    # Which local name refers to which importable module.
    aliases: dict[str, str] = {}
    for _, source in cells:
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    aliases[alias.asname or alias.name.split(".")[0]] = alias.name

    modules: dict[str, object] = {}
    skipped: list[str] = []
    for local, name in aliases.items():
        try:
            modules[local] = importlib.import_module(name)
        except Exception:
            skipped.append(name)

    problems: list[str] = []
    reported: set[str] = set()
    for index, source in cells:
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.Attribute):
                continue
            path = dotted(node)
            if not path:
                continue
            root, *rest = path.split(".")
            if root not in modules or not rest:
                continue
            target = modules[root]
            walked = root
            for part in rest:
                if not hasattr(target, part):
                    key = f"{walked}.{part}"
                    if key not in reported:
                        reported.add(key)
                        problems.append(
                            f"cell {index} line {node.lineno}: "
                            f"{walked!r} has no attribute {part!r} — `{path}` fails at runtime"
                        )
                    break
                target = getattr(target, part)
                walked = f"{walked}.{part}"
    return problems, sorted(set(skipped))


def check(path: Path, strict: bool) -> bool:
    cells = code_cells(json.loads(path.read_text()))
    name = path.name

    problems = syntax_problems(cells)
    if problems:
        print(f"FAIL {name} ({len(cells)} code cells) — syntax")
        for p in problems:
            print(f"  - {p}")
        return False

    problems = undefined_names(cells)
    attrs, skipped = attribute_problems(cells)
    problems += attrs

    if problems:
        print(f"FAIL {name} ({len(cells)} code cells)")
        for p in problems:
            print(f"  - {p}")
        return False

    note = f" (attribute pass skipped: {', '.join(skipped)})" if skipped else ""
    if skipped and strict:
        print(f"FAIL {name} — --strict, and these are not installed: {', '.join(skipped)}")
        return False
    print(f"ok   {name} ({len(cells)} code cells){note}")
    return True


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    strict = "--strict" in argv
    paths = [Path(a) for a in args] or sorted(FIXTURES.glob("*.ipynb"))
    if not paths:
        print(f"no notebooks found in {FIXTURES}", file=sys.stderr)
        return 1
    return 0 if all([check(p, strict) for p in paths]) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
