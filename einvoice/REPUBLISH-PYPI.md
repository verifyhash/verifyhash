# REPUBLISH-PYPI — first-publish `verifyhash-einvoice` to PyPI (owner action, ~10 min)

The einvoice validator is packaged and passes every packaging gate, but it has
**never been published to PyPI**. This is the owner runbook to publish it. The
loop stages this packet but **never uploads** — publishing needs a PyPI account
+ API token that only the owner holds.

## Status at staging (2026-07-16)

| Fact | Value | How checked |
|---|---|---|
| Distribution name | `verifyhash-einvoice` | `pyproject.toml` `[project] name` |
| Name availability on PyPI | **AVAILABLE** — `GET https://pypi.org/pypi/verifyhash-einvoice/json` → **HTTP 404** (`{"message": "Not Found"}`), observed **2026-07-16T10:20:40Z** | public read-only GET; 404 = no such project = the name is free to claim |
| Version to publish | `0.1.0` | `pyproject.toml` `[project] version`, matches `einvoice.__version__` |
| Runtime dependencies | **none** (stdlib only) | `pyproject.toml` `dependencies = []`, enforced by `test_packaging.py` + `test_pypi_packaging.py` |
| Console script | `einvoice = einvoice.cli:main` | `pyproject.toml` `[project.scripts]` |
| Built artifact staged under `einvoice/dist/` | **NONE** — see next section | no wheel/sdist could be built on this box |

### Why no `dist/` artifact is committed

A wheel/sdist could **not** be built on the loop box, and the packet does not
pretend otherwise. The box has Python 3.10.12 and a working `python3 -m venv`,
but:

- `python3 -m build` (the `build` module) is **absent**, and
- `setuptools` is **59.6.0**, older than the `setuptools>=61` that this
  project's PEP 621 `[project]` table requires.

Building the wheel would therefore need PyPI network access (pip build
isolation fetching a newer setuptools), and `--no-build-isolation` fails on the
old setuptools. So `einvoice/dist/` is intentionally empty and the
`test_pypi_packaging.py` wheel-from-venv proof is **DEFERRED-ON-TOOLCHAIN**
rather than run.

Installing `python3-build` / `setuptools>=61` on the box is an **already-open
needs-human** (do not re-file it). Once present, the owner commands below build
and upload the artifact for real, and `test_pypi_packaging.py` runs its full
build → clean-venv → `einvoice --version` proof automatically.

## Prerequisites (owner, one-time)

1. A PyPI account (https://pypi.org). **Do not have the loop create accounts or
   tokens — this is owner-only.**
2. A **PyPI API token** scoped to this project (or an account-wide "Entire
   account" token for the first upload, then narrow it). Create it at
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
   shell history.
3. Build + upload tooling on the machine you publish from:

   ```bash
   python3 -m pip install --upgrade build twine
   ```

## Owner command sequence (one sitting, ~10 min)

From a checkout of this repo, in `einvoice/`:

```bash
cd /path/to/verifyhash/einvoice

# 0. gates first — never publish a red tree
python3 test_packaging.py
python3 test_pypi_packaging.py

# 1. clean any stale build output, then build the sdist + wheel
rm -rf dist build *.egg-info
python3 -m build            # writes dist/verifyhash_einvoice-0.1.0-py3-none-any.whl
                            #    and dist/verifyhash_einvoice-0.1.0.tar.gz

# 2. sanity-check the metadata renders (catches a bad long_description)
python3 -m twine check dist/*

# 3. (recommended first-time) upload to TestPyPI and dry-run the install
python3 -m twine upload --repository testpypi dist/*
#   then, in a scratch venv:
#   python3 -m pip install --index-url https://test.pypi.org/simple/ verifyhash-einvoice
#   einvoice --version   # -> einvoice 0.1.0

# 4. upload to the real PyPI
python3 -m twine upload dist/*
```

`twine upload dist/*` ships both the wheel and the sdist built in step 1. On a
first publish of `verifyhash-einvoice` this claims the name recorded AVAILABLE
above; re-running a version already on PyPI fails fast with
`400 File already exists` (versions are immutable — bump `version` in
`pyproject.toml` for a re-release).

## Post-publish verification (clean venv)

In a fresh directory, prove a stranger can install from PyPI and the console
script works:

```bash
python3 -m venv /tmp/vh-check && . /tmp/vh-check/bin/activate
python3 -m pip install verifyhash-einvoice && einvoice --version
#   expected: einvoice 0.1.0
deactivate && rm -rf /tmp/vh-check
```

Optional extra checks:

- `python3 -m pip show verifyhash-einvoice` — confirm `Requires:` is **empty**
  (the zero-dependency contract survived the round-trip).
- Open <https://pypi.org/project/verifyhash-einvoice/> and confirm the
  description keeps the implemented-subset scope caveat (no full-standard
  overclaim).

## Hard limits (the loop obeyed these; the owner should too)

- **Never** commit `~/.pypirc`, a token, or any secret to the repo.
- **Never** upload from the loop — publishing is an owner action.
- The distribution stays **zero runtime dependencies**; if a future change
  wants a dependency, that is a product decision, not a packaging tweak.
