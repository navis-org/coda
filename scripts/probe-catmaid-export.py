"""Run the notebook exported from `catmaidGraph` and compare it with what the canvas produced.

    pnpm probe:catmaid

The second half of `src/export/catmaid.live.test.ts`, which ran the same graph against Virtual
Fly Brain through a real Scheduler and wrote `canvas.json` and `catmaid.ipynb` into one directory.
This executes every code cell of the notebook in one namespace — against the same public servers,
read only — and compares each node's variable with the canvas's value for it.

The comparison is of *rows as a set*: pymaid fetches connector links in chunks of fifty skeletons
and the canvas fetches them per relation, so the same links arrive in a different order, and
nothing downstream of either reads that order. Everything else must agree exactly, apart from the
float tolerance a position or a cable length rounded through JSON needs.

Needs pymaid (`pip install python-catmaid`) and a network. Exits non-zero on any disagreement.
"""

import json
import math
import os
import sys

import pandas as pd

DIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('CATMAID_PROBE_OUT', '/tmp/coda-catmaid-probe')

# Node id on the canvas -> port -> the notebook variable bound to it. Written out rather than
# derived: a variable a renamed emitter stops binding should fail here by name, not vanish.
PORTS = {
    'find': {'neurons': 'find_neurons'},
    'explore': {'all': 'explore_dataset_all_', 'hits': 'explore_dataset_hits',
                'selected': 'explore_dataset_selected'},
    'ids': {'neurons': 'input_ids'},
    'conn': {'connections': 'connectivity_connections', 'neuronSet': 'connectivity_neuron_set'},
    'walk': {'connections': 'connectivity_2_connections',
             'neuronSet': 'connectivity_2_neuron_set'},
    'adj': {'matrix': 'adjacency_matrix', 'links': 'adjacency_links'},
    'adjType': {'matrix': 'adjacency_2_matrix', 'links': 'adjacency_2_links'},
    'skel': {'skeletons': 'skeletons'},
    'syn': {'points': 'synapses'},
    'synPre': {'points': 'synapses_2'},
    'between': {'points': 'synapses_between'},
    'betweenOut': {'points': 'synapses_between_2'},
    'rmesh': {'meshes': 'roi_meshes'},
    'l1find': {'neurons': 'find_neurons_2'},
}

def run_notebook(path):
    # Quiet, before the notebook's own `import pymaid` rebinds the same module: its progress bars
    # and cache notices would bury the comparison.
    import pymaid
    pymaid.set_loggers('WARNING')
    pymaid.set_pbars(hide=True)
    notebook = json.load(open(path))
    scope = {}
    for cell in notebook['cells']:
        if cell['cell_type'] != 'code':
            continue
        exec(compile(''.join(cell['source']), path, 'exec'), scope)
    return scope


def same(a, b):
    if a is None or (isinstance(a, float) and math.isnan(a)):
        return b is None or (isinstance(b, float) and math.isnan(b)) or b is pd.NA
    if isinstance(a, float) or isinstance(b, float):
        try:
            return math.isclose(float(a), float(b), rel_tol=1e-6, abs_tol=1e-3)
        except (TypeError, ValueError):
            return False
    return str(a) == str(b)


def normalised(rows, columns):
    """Rows as tuples over `columns`, sorted, with NaN and NA read as None."""
    out = []
    for row in rows:
        values = []
        for c in columns:
            v = row.get(c)
            if v is pd.NA or (isinstance(v, float) and math.isnan(v)):
                v = None
            values.append(v)
        out.append(tuple(values))
    return sorted(out, key=lambda t: tuple('' if v is None else str(v) for v in t))


def compare_rows(label, canvas_rows, frame):
    problems = []
    notebook_rows = frame.to_dict('records')
    columns = list(canvas_rows[0].keys()) if canvas_rows else list(frame.columns)
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        return [f'{label}: notebook has no column(s) {missing}; it has {list(frame.columns)}']
    if len(canvas_rows) != len(notebook_rows):
        problems.append(f'{label}: {len(canvas_rows)} rows on the canvas, {len(notebook_rows)} in the notebook')
    a = normalised(canvas_rows, columns)
    b = normalised(notebook_rows, columns)
    bad = 0
    for x, y in zip(a, b):
        if not all(same(p, q) for p, q in zip(x, y)):
            bad += 1
            if bad <= 3:
                problems.append(f'{label}: canvas {dict(zip(columns, x))}\n{" " * len(label)}  notebook {dict(zip(columns, y))}')
    if bad:
        problems.append(f'{label}: {bad} of {len(a)} rows differ')
    return problems


def compare(label, canvas, value):
    kind = canvas['kind']
    if kind in ('table', 'points'):
        return compare_rows(label, canvas['rows'], value)
    if kind == 'matrix':
        frame = value
        problems = []
        if [str(x) for x in frame.index] != canvas['rowLabels']:
            problems.append(f'{label}: row labels differ: {list(frame.index)[:5]} vs {canvas["rowLabels"][:5]}')
        if [str(x) for x in frame.columns] != canvas['colLabels']:
            problems.append(f'{label}: column labels differ')
        flat = [float(v) for v in frame.to_numpy().ravel()]
        if len(flat) != len(canvas['values']) or any(not same(p, q) for p, q in zip(canvas['values'], flat)):
            problems.append(f'{label}: cell values differ (sum {sum(canvas["values"])} vs {sum(flat)})')
        return problems
    if kind == 'skeletons':
        problems = []
        by_id = {str(n.id): n for n in value}
        for item, attrs in zip(canvas['items'], canvas['attributes']):
            n = by_id.get(item['id'])
            if n is None:
                problems.append(f'{label}: no neuron {item["id"]} in the notebook')
                continue
            if n.n_nodes != item['nodes']:
                problems.append(f'{label} {item["id"]}: {item["nodes"]} nodes vs {n.n_nodes}')
            cable = n.cable_length
            cable = float(getattr(cable, 'magnitude', cable))
            if not same(attrs['cableLength'], cable):
                problems.append(f'{label} {item["id"]}: cable {attrs["cableLength"]} vs {cable}')
            soma = 0 if n.soma is None else len(n.soma) if hasattr(n.soma, '__len__') else 1
            if soma != item['soma']:
                problems.append(f'{label} {item["id"]}: {item["soma"]} soma nodes vs {soma}')
        if len(by_id) != len(canvas['items']):
            problems.append(f'{label}: {len(canvas["items"])} skeletons vs {len(by_id)}')
        return problems
    if kind == 'meshes':
        problems = []
        by_name = {v.name: v for v in value}
        for item in canvas['items']:
            v = by_name.get(item['id'])
            if v is None:
                problems.append(f'{label}: no volume {item["id"]}')
            elif len(v.faces) != item['faces']:
                problems.append(f'{label} {item["id"]}: {item["faces"]} faces vs {len(v.faces)}')
            else:
                # Faces and bounds, not vertices: the canvas keeps one vertex per triangle corner.
                lo, hi = v.vertices.min(axis=0), v.vertices.max(axis=0)
                want = item['bounds']
                got = {'min': list(lo), 'max': list(hi)}
                if not all(same(a, b) for k in ('min', 'max') for a, b in zip(want[k], got[k])):
                    problems.append(f'{label} {item["id"]}: bounds {want} vs {got}')
        return problems
    return [f'{label}: no comparison for kind {kind}']


def main():
    canvas = json.load(open(os.path.join(DIR, 'canvas.json')))
    scope = run_notebook(os.path.join(DIR, 'catmaid.ipynb'))
    problems = []
    checked = 0
    for node, ports in PORTS.items():
        entry = canvas[node]
        if entry['state'] != 'ok':
            problems.append(f'{node}: the canvas did not run it ({entry["state"]}: {entry.get("error")})')
            continue
        for port, variable in ports.items():
            if variable not in scope:
                problems.append(f'{node}.{port}: the notebook binds no `{variable}`')
                continue
            found = compare(f'{node}.{port}', entry['outputs'][port], scope[variable])
            problems.extend(found)
            checked += 1
            print(f'{"FAIL" if found else "ok  "} {node}.{port} ({variable})')
    if problems:
        print('\n' + '\n'.join(problems))
        sys.exit(1)
    print(f'\n{checked} outputs agree with the canvas.')


if __name__ == '__main__':
    main()
