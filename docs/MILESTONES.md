# Milestones and acceptance criteria

Status as of 2026-11-02: milestones are in progress; none is complete. GitHub milestones and their linked issues track outstanding work. Domain code is not the finished application or clinical evidence. Patient data must not appear in those records.

After each merged PR, the orchestrator updates the related issue checklist and this summary when milestone-level progress changes. Before closing a milestone, verify every exit criterion and link review/test evidence; do not infer device, security, licensing or clinical approval from unit tests.

| Milestone | Current verified progress | Remaining gate |
| --- | --- | --- |
| M0 | Repo, CI and Windows handoff merged. User reports Ollama/OCR installed on PC. | Target GPU/OCR evidence, data rights, private HTTPS and phone tests. |
| M1 | Profile and ingredient stores, recipe calculator and experimental local API merged. | Authenticated UI/API, usable caregiver workflow, integration/E2E and clinical/data validation. |
| M2 | Recipe domain and immutable meal snapshots/corrections merged. | UI, E2E and corrected-date goal interpretation (#15). |
| M3 | OCR Windows test plan and integration task (#18) created. | Connect local model, photo review and field validation, model terms (#10), real-device evidence. |
| M4 | Mobile shell merged. | Authentication/security review (#9), Windows backup/restore (#13), PWA and private remote device tests. |
| M5 | Clinical/data review gates documented. | Clinician review and real-person acceptance. |
| M6 | Deferred. | Hosting, cost, migration and security decision. |

## M0 — Foundation and feasibility

- Initialize repo, project instructions, task/PR templates, CI and clean development setup. The repo is now public; never commit secrets or health data. Record runtime and dependency licenses.
- Verify Windows 11 machine, GPU, drivers, VRAM, phone/browser and availability of actual Codex agent models. Establish independently reviewed workflow.
- Run local Typhoon OCR 1.5 3B on representative consented label photos; record exact configuration and field-level accuracy. Investigate RTX 50-series report; document a manual-entry path regardless of results.
- Assess legal permission and traceable access for each proposed food data source; start source register. Test private remote phone connection, HTTPS, authentication and PWA/camera support without exposing services publicly.
- Exit: reproducible evidence for each spike or a documented blocker and decision; no production or clinical-use claim.

## M1 — Profile and calculation

- Store patient profiles, dated dry weight and individually entered, dated clinician goals. Support manually entered ingredients with documented units, source and nullable nutrients.
- Build a whole recipe, enter quantities, calculate nutrient estimates and scale by recorded portion. Show missing data and known subtotal; no unsupported unit conversions or target reassurance.
- Exit: unit and integration tests for known calculations, true zero versus unknown, boundary values, units, fraction scaling and validation. A reviewer checks examples and clinician review remains pending.

## M2 — Recipes and tracking

- Save/edit recipes and favorites; log actual consumption and show daily/weekly totals in Asia/Bangkok. Preserve versioned recipe/nutrient and goal snapshots at log time.
- Exit: integration/E2E evidence for create, reuse, edit without rewriting history, day/week boundaries, incomplete values and correction of logged meals.

## M3 — Label capture and OCR

- Capture or choose photos, locally process via Typhoon, review image and extracted fields, edit, confirm and save branded products. Support unavailable/failed OCR and manual entry.
- Exit: measured representative Thai label test covering serving basis, numbers, units and absent nutrients; user confirmation required; input/security checks and no unauthorized external transfers. Record accuracy and failures, not just a demo.

## M4 — Mobile PWA, remote access, backup

- Make common flows accessible on actual phone, install PWA, validate camera under HTTPS, authentication, private remote access, and clear unavailable/offline state. Implement encrypted backup and tested restore including photos and versioned records.
- Exit: caregiver usability test, accessibility checks, security review, remote access tested on a different network and full clean restore. Record device and browser versions; no promise of operation with the PC off.

## M5 — Clinical/data review and personal-use release

- Review entered goals, representative ingredients and labels, manual calculations, portion assumptions, incomplete-data presentation and example meals with a kidney dietitian or treating clinician. Review each source's permission and version.
- Exit: human sign-off and unresolved issues recorded; user accepts release after documented validation. Until then clearly label outputs as unvalidated estimates and do not rely on them for clinical decisions.

## M6 — Future VPS

- Decide whether hosting is needed. Assess costs, GPU availability, latency, model licensing, security, backups and restore, migration/rollback, and personal data handling.
- Exit: migration plan and independent security review approved and tested with non-patient data before any transfer. No automatic production deployment.
