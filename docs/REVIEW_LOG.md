# Independent review log

## Calculator prototype — 2026-11-02

Independent code review found that bare quantities do not carry units or raw/cooked state. The calculator therefore cannot reject incompatible units or food states. **Integration and clinical use are blocked** until a validated ingredient/source contract rejects these mismatches and tests demonstrate it. The caller must also surface partial results as incomplete and never indicate that an incomplete total is within a limit.

Follow-up: calculator now rejects mismatched units and food states; independent review found an empty-iterator bug, which was fixed and re-reviewed. Six tests pass. Integration remains blocked until the reference unit and state are tied to verified provenance rather than merely user assertions.

Portions assume uniform mixing. Food data provenance, rounding policy, real-device tests, and clinical verification remain open. Review is not clinical approval.
