# Thai Renal Nutrition Planner — master plan

Status: user approved the direction on 2026-11-02. Implementation and clinical validation are pending.

## Purpose and users

A Thai-language, mobile-first, elderly-friendly PWA helps a caregiver plan Thai meals for a person with kidney disease. The caregiver prepares food using a scale, physician-provided goals, saved recipes and product labels. It estimates food composition; it does not prescribe treatment. No AI chatbot in the initial scope.

## Approved deployment direction

- Development project is on the current Mac; first operational host is the user's always-on Windows 11 PC with RTX 5070. Hardware, OS versions, VRAM and actual performance require verification on that PC.
- A phone must work from home and remotely. Prefer an authenticated private network with HTTPS and device access control; validate actual phone/browser support, certificate lifecycle, operating cost, recovery and privacy before selecting a product. Never expose the database or Ollama directly to the internet. The PC being on is acceptable; connectivity is still required. No production remote exposure before security review.
- Proposed stack: React/TypeScript PWA, Python/FastAPI, SQLite for one host, local Ollama OCR. Confirm practical installation, backup, upgrades and mobile HTTPS in the foundation spike. Migration to a VPS is a later decision, not an assumed compatibility guarantee.

## Product workflow

1. Create multiple patient profiles. Store dry weight separately from other measured weights, their dates, optional relevant notes and physician/dietitian-set nutrient goals and effective dates. The user enters goals; do not calculate a prescription from weight or diagnosis.
2. Search Thai ingredient records, verified branded products and personal ingredients. Record source, version, source date, food preparation state, nutrient basis, units and review status. Allow manual entry and corrections.
3. Build a whole recipe from quantities in compatible units. Show calculated values for energy, protein, sodium, potassium and phosphorus and identify missing information. Save favorites and reusable recipes.
4. Divide the whole recipe into a recorded fraction or equivalent measured portions. Explain equal-distribution assumption and that uneven solids/liquid create error. Record actual consumption separately from a planned amount.
5. Show daily and weekly totals using the patient's local calendar. Preserve calculation inputs and goals at time of logging so later edits do not rewrite history.
6. Photograph/select a label; process locally; show image and proposed fields together. User checks and corrects every value before saving. Manual entry remains available if OCR fails. Label values may omit important nutrients.
7. Back up and restore patient data, recipes, product records and photos; test restoration before real use.

## Calculation and data rules

- Each nutrient is either a documented numeric value, including a genuine zero, or unknown. Never substitute zero for unknown. Display known subtotal and a conspicuous incomplete status; do not assert target compliance or safety where required inputs are missing.
- Nutrients are estimated from source basis, entered quantity, and fraction consumed. Units must match and be validated; no guessed grams-to-millilitres or piece/spoon conversions. A documented ingredient-specific conversion may be entered and reviewed. Raw/cooked variants are distinct; cooking losses and uneven distribution are not silently inferred.
- Retain source identity, original values and units, version, retrieval/date, provenance, review and applicable licensing. A correction creates a traceable version. Branded labels may change by product and date. Do not invent or silently infer absent values.
- Source data and changes to calculation, units, target interpretation or safety language require the clinical/data gate in [CLINICAL_DATA_QA.md](CLINICAL_DATA_QA.md). Personal use does not itself grant permission to copy, scrape, redistribute or commit source data. Use approved rights or manually entered values; keep unresolved sources out of distribution.

## OCR

Test the user's chosen Typhoon OCR 1.5 3B using the model provider's prescribed prompt and local Ollama build. Record exact model digest, runtime, GPU/driver versions, latency, memory, output and field-level error for representative Thai nutrition labels, including blur and units. OCR is untrusted assistance, not ground truth; never auto-confirm fields. Known report of repeated output on RTX 5060/Blackwell: https://github.com/scb-10x/typhoon-ocr/issues/14 . This does not establish whether RTX 5070 fails. Stop and report failure; provide manual entry and evaluate a compatible runtime/model only as an explicit decision. Check model and runtime licenses independently: https://huggingface.co/typhoon-ai/typhoon-ocr1.5-3b-qat .

## Security and privacy

Private repo is not a health-data store. Keep patient records, label photos, backups, credentials, API tokens and database files out of Git, issues, CI and agent prompts. Validate uploads, restrict upload size and types, authenticate the single administrator, protect sessions, validate all input, sanitize errors and logs, and use least privilege. Protect remote access with authenticated encrypted transport and access control. Encrypt backups and establish a user-managed recovery procedure; test backup and restore without revealing credentials.

## Implementation and governance

Use milestone files and acceptance criteria in [MILESTONES.md](MILESTONES.md). Each task identifies scope, dependencies, tests and risk; work in isolated branches, create PRs and obtain independent review from an agent that did not implement the change. CI and reviewer findings must pass before merge. Use unit, integration and critical-flow E2E tests; add meaningful regression tests for calculation, units, unknowns, historical snapshots, auth, upload and backup. Clinical/data changes require explicit human review as specified in the gate; an agent cannot provide clinical approval. Agent orchestration must test available models and roles in the actual environment; report unavailable models rather than pretending a fallback exists. Keep task, PR and review records free of patient data.

## Open evidence and decisions

Actual Windows setup, exact RTX 5070/VRAM, OCR compatibility, phone/browser, network/private-access solution, dataset permissions, target values and clinician review remain unverified. The next stage is a foundation spike, not clinical deployment. VPS hosting, GPU resources, security, costs and migration remain deferred until evaluated.
