# Incident Report INC-2026-0042

- **Opened:** 2026-05-12 09:14 UTC
- **Severity:** SEV-2
- **Component:** auth-gateway

## Summary

A misconfigured rate-limit rule allowed elevated request volume from a
single tenant for 38 minutes. No data exfiltration was observed.

## Remediation

1. Reverted the rule change.
2. Added a regression test pinning the per-tenant ceiling.
3. Re-ran the access review (see access-log.csv).

## Sign-off

Reviewed by the on-call lead and the compliance owner.
