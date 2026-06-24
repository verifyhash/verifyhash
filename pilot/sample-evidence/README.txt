Sample evidence bundle (pilot fixture)
======================================

These tiny, committed files stand in for the kind of compliance/audit
artifacts an evidence-vertical design partner would seal into ONE
tamper-evident *.vhevidence.json packet:

  - incident-report.md   a human-written incident write-up
  - access-log.csv       a machine-exported access log
  - control-matrix.json  a structured control/attestation matrix
  - README.txt           this file

The pilot kit (pilot/run-pilot.js) seals a COPY of this directory in a
throwaway temp workspace, signs it under an ephemeral vendor license,
hands the packet to the independent verifier, and proves a tamper is
rejected. Nothing here is ever mutated in place.
