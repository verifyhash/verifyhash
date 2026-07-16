# GitHub repo "About" packet — owner paste (≈2 minutes)

GitHub renders the README automatically, but the small **About** box on the right of the repo
page (description + topics) is set in the repo UI and the loop never touches repo settings. This
file is the copy the owner pastes there by hand.

**Where:** repo home page → the gear icon (⚙) next to **About** → paste the description into
*Description*, add the topics into *Topics*, save.

---

## Suggested repo description (About text)

Pick one. Both are one line and stay honest about the two products this repo ships.

**Primary (covers both products):**

```
Tamper-evidence toolkit (npm verifyhash / verify-vh) + a zero-dependency EN 16931 / XRechnung / Factur-X e-invoice validator. Offline, permissionless, CI-gateable.
```

**Alternative (e-invoicing-forward, for the einvoice audience):**

```
Zero-dependency EN 16931 / XRechnung / Factur-X e-invoice validator (Python stdlib, offline, CI-gateable) — plus the verifyhash on-chain tamper-evidence tooling. Apache-2.0.
```

## Suggested website field (About → Website)

```
https://verifyhash.com/einvoice/
```

## Suggested topics

Paste these into the *Topics* field (GitHub lowercases and de-duplicates them):

```
en16931
xrechnung
e-invoicing
factur-x
invoice-validation
zugferd
tamper-evident
keccak256
python
```

The first five are the requested e-invoicing set (`en16931`, `xrechnung`, `e-invoicing`,
`factur-x`, `invoice-validation`); the rest tag the other surfaces the repo actually ships
(ZUGFeRD PDF containers, the on-chain tamper-evidence tooling, and the stdlib-Python
implementation) so both audiences can find it.

---

*Doc only. The owner pastes this into repo Settings; the loop does not edit GitHub repo settings.*
