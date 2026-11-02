# Independent review log

## Calculator prototype — 2026-11-02

Independent code review found that bare quantities do not carry units or raw/cooked state. The calculator therefore cannot reject incompatible units or food states. **Integration and clinical use are blocked** until a validated ingredient/source contract rejects these mismatches and tests demonstrate it. The caller must also surface partial results as incomplete and never indicate that an incomplete total is within a limit.

Portions assume uniform mixing. Food data provenance, rounding policy, real-device tests, and clinical verification remain open. Review is not clinical approval.
