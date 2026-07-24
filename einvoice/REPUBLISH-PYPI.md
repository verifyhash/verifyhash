# REPUBLISH-PYPI — publish `verifyhash-einvoice` 0.2.7 to PyPI (owner/supervisor action, ~10 min)

`verifyhash-einvoice` is already **live on PyPI**; the newest release the index
serves is **0.2.6**. This is the runbook for the *next* upload: version
**0.2.7**, which supersedes 0.2.6. The loop stages this packet but **never
uploads** — publishing needs a PyPI account + API token that only the owner
holds (a token is currently stored `0600` in the supervisor's `~/.pypirc`).

## PyPI versions are IMMUTABLE — this is a BUMP, not a re-cut

Read this before touching `twine`. **A version number, once uploaded to PyPI,
can never be re-uploaded, replaced or corrected — only superseded.** Yanking or
deleting a release does not free the version string either; PyPI refuses the
same `name==version` twice, and re-running an upload for an existing version
fails fast with `400 File already exists`.

That matters here because the **published 0.2.6 wheel is broken**, in three ways
measured before the fix landed:

- `--format sarif` — which is the DEFAULT format of the GitHub Action this repo
  ships — crashed with a traceback instead of emitting a report;
- `--explain <RULE-ID>` crashed;
- every report it emitted was hint-less: `title`, `fix_hint` and `location` came
  back `null` and `terms` came back empty, even though `report.schema.json`
  advertises all four. The cause was a packaging slip —
  `remediation_catalog.json` lived outside the `einvoice/` package directory that
  `packages = ["einvoice"]` ships, so a `pip install` user got a validator that
  names a broken rule and hands them nothing to fix it with.

Those defects are fixed in source — T-VHWHEEL.1 ships the catalog as
package-data, T-VHWHEEL.2 makes the sarif and `--explain` call sites degrade
instead of crash when the catalog is absent — and `test_wheel_remediation.py`
guards both halves from a wheel-only import root.

But **0.2.6 on PyPI stays broken forever**: it is immutable, so the fix cannot
be shipped as a corrected 0.2.6. It can only ship as a *new* version. That is
why `pyproject.toml` was bumped to 0.2.7 and why this runbook publishes 0.2.7
rather than re-cutting 0.2.6. Anyone who already installed 0.2.6 keeps a broken
wheel until they upgrade; `CHANGELOG.md` records the same reasoning.

Corollary: **do not publish until the tree you are publishing is the fixed one.**
Spending an immutable version on a still-broken build costs another version to
undo.

## Status at staging

| Fact | Value | How checked |
|---|---|---|
| Distribution name | `verifyhash-einvoice` | `pyproject.toml` `[project] name` |
| Name availability on PyPI | **no longer available — the name is CLAIMED by this project.** The `GET https://pypi.org/pypi/verifyhash-einvoice/json` that returned HTTP **404** ("the name is free") at first staging on 2026-07-16 now returns HTTP **200**; the name was claimed by the first upload on 2026-07-22 | public read-only GET against the JSON API (the HTML project page is behind a bot-wall and is not a reliable check) |
| Newest release PyPI serves | `0.2.6` | same JSON API, `info.version` |
| Version to publish | `0.2.7` | `pyproject.toml` `[project] version`, matches `einvoice.__version__` (lock-step enforced by `test_packaging.py`) |
| Relationship to 0.2.6 | **supersedes** it — 0.2.6 is immutable and stays downloadable forever | see the immutability section above |
| Runtime dependencies | **none** (stdlib only) | `pyproject.toml` `dependencies = []`, enforced by `test_packaging.py` + `test_pypi_packaging.py` |
| Console script | `einvoice = einvoice.cli:main` | `pyproject.toml` `[project.scripts]` |
| Built artifact staged under `einvoice/dist/` | **none committed** — `einvoice/dist/` is gitignored; build it fresh at publish time | step 1 below |

### Build toolchain on the box

Building used to be impossible here: the box shipped `setuptools` 59.6.0 — older
than the `setuptools>=61` this project's PEP 621 `[project]` table requires — and
no `build` module, so `python3 -m build` either failed or produced a broken
`UNKNOWN-0.0.0` wheel. That was resolved on 2026-07-22 (`python3.10-venv` plus a
user-level `pip install --upgrade build twine 'setuptools>=61'`), and
`python3 -m build` now emits correctly-named 0.2.7 artifacts. The
`test_pypi_packaging.py` wheel-from-venv proof is consequently **no longer
DEFERRED-ON-TOOLCHAIN** — it runs its full build → clean-venv →
`einvoice --version` check, and the deferred variant now reports as skipped.

## Prerequisites (owner, one-time)

1. A PyPI account (https://pypi.org). **Do not have the loop create accounts or
   tokens — this is owner-only.**
2. A **PyPI API token** scoped to this project. Create it at
   <https://pypi.org/manage/account/token/> and store it as documented at
   <https://packaging.python.org/en/latest/specifications/pypirc/> — either in
   `~/.pypirc`:

   ```ini
   [pypi]
     username = __token__
     password = pypi-AgEIcHl...    # your token, NEVER commit this file
   ```

   or via the `TWINE_USERNAME=__token__` / `TWINE_PASSWORD=pypi-...`
   environment variables. The token is a secret: keep it out of git and out of
   shell history. (The token used for the first upload was pasted in plaintext
   in chat and should be rotated — a still-open owner item.)
3. Build + upload tooling on the machine you publish from:

   ```bash
   python3 -m pip install --upgrade build twine
   ```

## Owner command sequence (one sitting, ~10 min)

From a checkout of this repo, in `einvoice/`:

```bash
cd /path/to/verifyhash/einvoice

# 0. gates first — never publish a red tree. The wheel-behaviour gate matters
#    most here: it is what stops a second immutable version going out broken.
python3 test_packaging.py
python3 test_pypi_packaging.py
python3 test_wheel_remediation.py

# 1. clean any stale build output, then build the sdist + wheel
rm -rf dist build *.egg-info
python3 -m build            # writes dist/verifyhash_einvoice-0.2.7-py3-none-any.whl
                            #    and dist/verifyhash_einvoice-0.2.7.tar.gz

# 2. sanity-check the metadata renders (catches a bad long_description)
python3 -m twine check dist/*

# 3. (recommended) upload to TestPyPI and dry-run the install
python3 -m twine upload --repository testpypi dist/*
#   then, in a scratch venv:
#   python3 -m pip install --index-url https://test.pypi.org/simple/ verifyhash-einvoice
#   einvoice --version   # -> einvoice 0.2.7

# 4. upload to the real PyPI
python3 -m twine upload dist/*
```

`twine upload dist/*` ships both the wheel and the sdist built in step 1. It
adds 0.2.7 alongside the existing releases; it does not — and cannot — touch the
already-published 0.2.6 files.

## Post-publish verification (clean venv)

In a fresh directory, prove a stranger can install from PyPI and that the
artifact PyPI actually serves (not the source tree) carries the fixes. Pin the
version explicitly so you are testing the upload you just made:

```bash
python3 -m venv /tmp/vh-check && . /tmp/vh-check/bin/activate
python3 -m pip install verifyhash-einvoice==0.2.7

einvoice --version
#   expected: einvoice 0.2.7

cd /tmp    # never verify from inside the checkout: cwd would shadow
           # site-packages and you would be testing the source tree

python3 -m einvoice.report --help                             # must exit 0
python3 -m einvoice.report --explain BR-DE-1                  # exit 0 + rule text
python3 -m einvoice.report --format sarif <any-invoice.xml>   # no traceback

deactivate && rm -rf /tmp/vh-check
```

The `--explain` and `sarif` checks are the whole point of this release: both
crashed in 0.2.6. A violating invoice must also come back with a non-null
`fix_hint` — for example an XRechnung invoice with `cbc:BuyerReference` removed
yields a `BR-DE-15` violation carrying `title`, `fix_hint`,
`location: "cbc:BuyerReference"` and `terms: ["BT-10"]`, where 0.2.6 returned
`null` for the first three and `[]` for the last.

Optional extra checks:

- `python3 -m pip show verifyhash-einvoice` — confirm `Requires:` is **empty**
  (the zero-dependency contract survived the round-trip).
- `curl -s https://pypi.org/pypi/verifyhash-einvoice/json` — HTTP 200, and
  `info.version` reads 0.2.7.
- Open <https://pypi.org/project/verifyhash-einvoice/> and confirm the
  description keeps the implemented-subset scope caveat (no full-standard
  overclaim).

## Hard limits (the loop obeyed these; the owner should too)

- **Never** commit `~/.pypirc`, a token, or any secret to the repo.
- **Never** upload from the loop — publishing is an owner/supervisor action.
- The distribution stays **zero runtime dependencies**; if a future change wants
  a dependency, that is a product decision, not a packaging tweak.
- Never try to "fix" a published version in place. Bump `version` in
  `pyproject.toml` (and `einvoice/__init__.py`, kept in lock-step) instead.
