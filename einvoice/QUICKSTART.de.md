# einvoice — Schnellstart auf Deutsch

> **Zurück zur englischen Doku:** der ausführliche, testausgeführte Quickstart
> ist [`QUICKSTART.md`](QUICKSTART.md); die vollständige Referenz (CLI-Vertrag,
> Abdeckungs- und Sicherheitsdetails) ist [`README.md`](README.md).

**einvoice** validiert elektronische Rechnungen offline gegen die
Geschäftsregeln von **EN 16931** und der deutschen **XRechnung** — auf der
Kommandozeile, ohne Cloud-Dienst, ohne Netzwerkzugriff, mit null
Laufzeitabhängigkeiten (reine Python-3-Standardbibliothek: kein Java, kein
Saxon, keine Schematron-Toolchain). Geprüft werden UBL-2.1-`Invoice`- und
UN/CEFACT-CII-Dateien, wahlweise im Profil `en16931` (europäischer Kern) oder
`xrechnung` (Kern plus die deutsche KoSIT-Schicht mit den `BR-DE-*`-Regeln:
Käuferreferenz/Leitweg-ID, Verkäuferkontakt, Zahlungsangaben, Skonto).

**Kommando-Parität, maschinell erzwungen:** jeder Befehl in einem Code-Block
dieser Seite ist **byte-identisch** mit einem Befehl aus den englischen,
gegen die echte Engine testausgeführten Anleitungen (`QUICKSTART.md` /
`README.md`). Der Paritäts-Test in `test_install_command_drift.py` schlägt
fehl, sobald hier ein Kommando auftaucht, das dort nicht steht — die deutsche
und die englische Anleitung können bei den Kommandos also nicht
auseinanderlaufen. Übersetzt ist auf dieser Seite nur die Prosa; amtliche
Regel- und Korrekturtexte werden **nicht** übersetzt (den deutschen
KoSIT-Originaltext liefert die CLI selbst, siehe `--lang de` unten).

## Was ein grünes Ergebnis ehrlich bedeutet

Der Prüfer setzt **297 Geschäftsregeln** durch; jede ist differentiell gegen
die offiziellen CEN-/KoSIT-Schematron-Artefakte bewiesen. Das maßgebliche,
maschinell geprüfte Regelinventar — mit jeder dokumentierten Ausnahme und
wörtlichen Artefakt-Belegen — ist [`COVERAGE.md`](COVERAGE.md); jede Zahl in
diesem Abschnitt lässt sich dort nachrechnen. Exit-Code `0` heißt: *keine
implementierte fatale Regel hat ausgelöst*. Es heißt **nicht**
„rechtsverbindlich konforme XRechnung“. Die wichtigsten Grenzen:

- **8** offizielle `BR-CL-*`-Codelisten-Prüfungen sind bewusst zurückgestellt
  und als dokumentierte Ausnahmen geführt — nicht als Abdeckung gezählt.
- Eine strukturelle **XSD-Validierung findet nicht statt**; geprüft werden
  die Geschäftsregeln, nicht das Schema.
- Ein UBL-`CreditNote`-Wurzelelement (Gutschrift) wird nicht unterstützt.
- **50 Regeln** tragen einen amtlichen deutschen Meldungstext aus dem
  mitgelieferten KoSIT-Artefakt; die CLI zeigt ihn unter `--lang de` wörtlich —
  nie eine maschinelle Übersetzung, die als amtlicher Text ausgegeben würde.
  Alle übrigen Regeln melden bewusst englisch (es existiert schlicht kein
  amtlicher deutscher Text zum Zitieren).

Lassen Sie vor dem tatsächlichen Einreichen trotzdem den offiziellen
Validator Ihres Empfängers laufen — dieses Werkzeug ist der schnelle
Vorab-Check, der die typischen Fehler früh und offline fängt.

## 1. Installieren bzw. direkt starten

Alles Folgende läuft aus dem Verzeichnis `einvoice/` eines
Repository-Checkouts (die relativen Pfade unten setzen das voraus). Die zwei
Beispielrechnungen liegen im Repository und werden in
[`examples/README.md`](examples/README.md) Feld für Feld erklärt:
`fixed.xml` ist eine gültige XRechnung, `broken.xml` dieselbe Datei ohne
Käuferreferenz (BT-10) und ohne Verkäuferkontakt (BG-6).

**a) Direkt aus dem Checkout — nichts zu installieren:**

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

**b) Per `pip` installieren**, wer das `einvoice`-Kommando im `PATH` will
(null Laufzeitabhängigkeiten, `dependencies = []` in `pyproject.toml`;
derselbe Codepfad wie Form a, per `test_packaging.py` bewiesen):

```sh
python3 -m pip install .
einvoice validate --profile xrechnung examples/01-missing-fields/fixed.xml
```

**c) Aus PyPI installieren**, wenn Sie gar keinen Checkout wollen — das
veröffentlichte Paket heißt `verifyhash-einvoice`:

```sh
python3 -m pip install verifyhash-einvoice
```

Achtung beim Namen: ein bloßes `pip install` mit dem kurzen Namen `einvoice`
holt ein **fremdes, gleichnamiges PyPI-Paket** — genau davor schützt der
Drift-Test (`test_install_command_drift.py`). Form b (`pip install .`)
installiert dagegen genau den Checkout, den Sie vor sich haben: der Weg für
air-gapped Rechner oder wenn Sie einen exakten Stand reproduzierbar pinnen
wollen. Alle drei Formen fahren denselben Codepfad.

Warum `--profile xrechnung`? Die zwei fehlenden Pflichtangaben sind deutsche
`BR-DE-*`-Regeln aus der XRechnung-Schicht, nicht aus dem EN-16931-Kern —
unter dem Standardprofil `en16931` besteht die kaputte Datei.

## 2. Eine Rechnung prüfen: der Exit-Code ist der Vertrag

Die gültige Rechnung endet mit Exit-Code **0**:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/fixed.xml; echo "exit=$?"
```

druckt nach der menschenlesbaren Zusammenfassung die Zeile `exit=0`. Die
kaputte Rechnung fällt mit Exit-Code **1** durch; die Ausgabe nennt die erste
verletzte fatale Regel samt betroffenem XML-Element und den beiden Wegen zur
Erklärung dieser Regel:

```sh
python3 einvoice.py validate --profile xrechnung examples/01-missing-fields/broken.xml
```

```text
FAIL: examples/01-missing-fields/broken.xml
  BR-DE-2: The group 'SELLER CONTACT' (BG-6) must be transmitted.
  offending element: cac:AccountingSupplierParty/cac:Party/cac:Contact
  how to fix: einvoice --explain BR-DE-2
  rule page:  https://verifyhash.com/einvoice/rules/BR-DE-2/
Syntax-binding warnings: 0
```

`einvoice --explain BR-DE-2 --lang de` gibt denselben Katalogeintrag mit dem
amtlichen deutschen Wortlaut aus (`--lang de` färbt auch die Meldung in der
zweiten Zeile oben ein); die `rule page` ist dieselbe Regel als Webseite. Die
Regel-ID stammt immer aus **diesem** Lauf, und die `rule page`-Zeile erscheint
nur für Regeln, die der mitgelieferte Remediation-Katalog wirklich führt.

Der komplette Vertrag für Skripte und CI-Gates: `0` = keine implementierte
fatale Regel verletzt, `1` = mindestens eine fatale Verletzung, `2` =
Bedienfehler, `3` = kein wohlgeformtes XML — die vollständige, testgeprüfte
Tabelle steht in [`EXIT-CODES.md`](EXIT-CODES.md).

Maschinenlesbar wird das Ergebnis mit `--json` (Exit-Code unverändert `1`,
alle Befunde inklusive Regel-ID, Meldung, Element und Schweregrad):

```sh
python3 einvoice.py validate --json --profile xrechnung examples/01-missing-fields/broken.xml
```

Verlassen Sie sich in Skripten auf den Exit-Code oder das JSON-Feld `valid`,
nie auf den menschenlesbaren Text. Deutsche Fehlermeldungen — für die 50
Regeln mit amtlichem KoSIT-Text — liefert die Option `--lang de`; sie ändert
ausschließlich den Meldungstext, nie Befunde, Exit-Codes oder das
`--json`-Ergebnis (Details: Abschnitt „German-language messages“ in
[`README.md`](README.md)).

## 3. Was steckt in diesem Build?

Bevor Sie einem grünen Ergebnis trauen, fragen Sie das Werkzeug selbst, was
es implementiert (nur lesend, Exit-Code `0`):

```
python3 -m einvoice info
```

nennt Version, Profile, Report-Formate, die Regelzahl und den
Attestierungs-Hash — jede Zahl wird zur Laufzeit aus denselben committeten
Artefakten gelesen, gegen die auch die Testsuite prüft. Als CI-Fähigkeits-Gate
vor dem eigentlichen Validieren (bricht ab, bevor eine Rechnung angefasst
wird, falls dem installierten Build ein benötigtes Profil oder Format fehlt):

```
python3 -m einvoice info --json | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'xrechnung' in d['profiles'] and 'sarif' in d['formats']"
```

## 4. CI-Anbindung: kein Build mit kaputter Rechnung

Für ein Repository voller Rechnungen liegt ein fertiges Gate-Skript bei
(POSIX `sh`, keine Abhängigkeiten außer `python3`): es prüft rekursiv jede
`*.xml`-Datei, lässt den Build bei jeder fatalen Verletzung mit der Regel-ID
im Log fehlschlagen und schreibt pro Rechnung einen JUnit-Report. Im CI-Job
wird der Validator aus PyPI installiert —

```sh
python3 -m pip install verifyhash-einvoice
```

— oder, als **Offline-Alternative** für Runner ohne Zugriff auf einen
Paketindex (air-gapped) bzw. wenn Sie den Stand reproduzierbar pinnen wollen,
das Produktverzeichnis vendoren (z. B. nach `third_party/einvoice/`) und die
vendorte Kopie installieren:

```sh
python3 -m pip install ./third_party/einvoice        # vendored copy; zero deps
```

Dann das Gate über die eigenen Rechnungsdateien laufen lassen (das Gate-Skript
selbst kopieren Sie mit ins Repository; der Pfad unten zeigt auf die vendorte
Ablage):

```sh
sh third_party/einvoice/ci/validate-invoices.sh invoices/
```

Kopierfertige GitHub-Actions- und GitLab-CI-Definitionen (inklusive
SARIF-Annotationen direkt im Pull Request) stehen in
[`ci/README.md`](ci/README.md) — diese Seite dupliziert sie bewusst nicht.

## Weiterführend (englisch)

- [`QUICKSTART.md`](QUICKSTART.md) — derselbe Ablauf ausführlicher, jedes
  Kommando von `test_quickstart.py` gegen die echte Engine ausgeführt.
- [`README.md`](README.md) — CLI-Vertrag, `--json`-Form, `--lang de`,
  Sicherheitsdetails zum Parsen nicht vertrauenswürdiger XML-Eingaben.
- [`COVERAGE.md`](COVERAGE.md) — das ehrliche Regelinventar: jede Regel, ihr
  Beweis, jede Ausnahme.
- [`examples/README.md`](examples/README.md) — die kaputte Rechnung von oben
  Schritt für Schritt reparieren.
- [`API.md`](API.md) — den Prüfer als Python-Bibliothek in die eigene
  Testsuite einbetten.
