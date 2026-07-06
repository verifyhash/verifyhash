# Vendored artifact provenance

Official KoSIT **XRechnung Schematron v2.5.0** (compatible with XRechnung
3.0.2 — the same XRechnung version the vendored `corpus/xrechnung-testsuite`
targets).

- Source: https://github.com/itplr-kosit/xrechnung-schematron
  (release tag `v2.5.0`, asset `xrechnung-3.0.2-schematron-2.5.0.zip`),
  extracted verbatim — no local modifications.
- License: Apache-2.0 (see `LICENSE` in this directory), compatible with this
  repository's license.
- Role here: **legal ground truth** for the German national CIUS rules
  (`BR-DE-*`). `differential.py` (the `xrechnung` leg) runs every corpus
  invoice through the compiled official XSLT
  (`schematron/ubl/XRechnung-UBL-validation.xsl`) and compares its fired-rule
  set against our `einvoice/rules_xrechnung.py` layer — see
  `einvoice/CORRECTNESS.md` §2a.
