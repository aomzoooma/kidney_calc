# Project rules

Personal renal nutrition planning aid, not an autonomous medical adviser. Never invent clinical goals, nutrient values, conversions, or data rights. Missing nutrients are unknown, not zero; show incomplete totals clearly. Preserve dated snapshots of consumed entries and goals. Nutrition calculations, units, data sources, and clinical behavior require evidence, tests, independent review, and clinical review before real-world reliance.

Work by milestone from docs/. Each task uses a focused branch and pull request with acceptance criteria, tests, and independent review by an agent other than its implementer. Resolve high-severity findings before merge. Verify model and agent availability in the active environment before assigning; fall back to an available model and report it, never claim unavailable automation. No unattended clinical or data approval. Use synthetic data in development and CI. Never commit patient data, photos, secrets, local databases, or model weights. Check licenses and redistribution rights for each dataset and dependency before import.

Git workflow: `develop` is the default integration branch. Create every agent task branch from the latest `develop` and target its PR to `develop`. `main` is reserved for releases; promote reviewed, tested `develop` to `main` through a release PR when the user authorizes a release. Never push task changes directly to `main` or `develop`.

Preferred agent models: GPT-6 Luna for implementation and routine tests; GPT-6.1 Terra for independent review, QA, and orchestration when available. Check actual model availability at execution time; report any fallback. The current session's orchestrator model cannot be changed by this file.

Windows handoff: start with docs/WINDOWS_SETUP.md and docs/WINDOWS_OCR_TEST.md. The GitHub repository is public: never upload patient information, labels, secrets, databases, backups, or model weights. Check current branch, PRs, and open issues before work. Do not poll or wait for active agents; continue independent work and process their reports when delivered.

Maintain unit, integration, and critical-flow E2E coverage appropriate to each milestone; test unknown values, units, portions, rounding, history, input validation and backup restoration. Record actual test and review outcomes in the PR. Protect authentication, local data, uploads, and backup. Bind services to localhost and use authenticated private access; never expose database or OCR publicly. Confirm remote access and camera on a real phone before release. Do not deploy without explicit authorization.

For TypeScript domain dates use Temporal, Asia/Bangkok for the patient's civil day. Keep interfaces Thai, mobile-first, accessible, and usable by an older caregiver. No invented values or clinical clearance. Preserve unrelated changes.
