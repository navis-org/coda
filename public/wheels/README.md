# DotMotif runtime wheels

These small, unmodified pure-Python wheels are served from Coda's own origin.
`manifest.json` records their provenance and SHA-256 hashes. The real Pyodide
probe verifies those hashes before loading them.

- DotMotif 0.19.0 is the official wheel from its GitHub release, at commit
  `125fdbca18c1c8ac7ed1b8d3f595669edc36574f`. That release is not on PyPI.
- GrandIso 2.2.0 publishes only a source archive. The wheel here was built from
  that archive with pinned build tools. Coda searches with DotMotif's GrandIso
  executor; NetworkX supplies the graph data structure and constraint helpers.

Both wheels contain their upstream Apache-2.0 license in
`<package>-<version>.dist-info/licenses/LICENSE`; a copy is included here as
`LICENSE.txt`. Package metadata may report an older license classification;
the shipped license text is preserved verbatim.

To restore the official DotMotif artifact:

```sh
curl --fail --location \
  https://github.com/aplbrain/dotmotif/releases/download/v0.19.0/dotmotif-0.19.0-py3-none-any.whl \
  --output public/wheels/dotmotif-0.19.0-py3-none-any.whl
```

To rebuild GrandIso with `uv` from the repository root:

```sh
SOURCE_DATE_EPOCH=315532800 uv run --python 3.12 --no-project \
  --with pip==26.0.1 --with setuptools==80.9.0 --with wheel==0.45.1 \
  python -m pip wheel --no-deps --no-build-isolation --no-cache-dir \
  --wheel-dir public/wheels \
  'https://files.pythonhosted.org/packages/65/c6/27400e2d81bd769ebe65c695cead44c8efb55ac3769826a01c9223d65709/grandiso-2.2.0.tar.gz#sha256=66f292d27328e13122065c7905ad0ac79c4649f69a35e7b98a3631654a0bf77c'
```

NetworkX 3.6.1 and Lark 1.3.1 use their pinned PyPI wheel URLs in
`src/pyodide/sources.json`. Passing full wheel URLs to `loadPackage` avoids the
Pyodide package catalog's optional NetworkX dependencies (matplotlib, numpy)
and DotMotif's unused ingest dependencies (pandas, numpy). The probe checks that
none is loaded. No runtime dependency resolution or code compilation occurs in
the browser.
