# Clinical, data and QA gates

## Clinical safety gate

No default nutrient prescription or diagnosis-driven rule. Patient-specific goals come from a clinician or kidney dietitian and are manually entered with units and effective date. Record who confirmed each goal without placing patient-identifying details in Git. Clinical reviewer checks representative manual calculations, source suitability, targets, portion logic, missing values and warning language before real-care use and again for material changes. Human approval is required; agent review cannot substitute. If unavailable, status is blocked for clinical use.

## Data gate

For every dataset or label record, retain name, provider, version, retrieval date, source reference, food/preparation state, nutrient basis and units, provenance and verification status. Maintain an evidence-backed permission/license decision for storage, use, scraping, redistribution and private-repo inclusion separately. Personal/noncommercial use alone is not permission. No bulk import until permissions and quality are verified. User-entered labels are reviewed against original images before use. Distinguish missing/unknown from real zero; never fabricate values or display an incomplete total as complete or safe.

## Calculation review

Use independently checked reference examples covering per-100g and per-serving values; compatible quantities; exact zero versus missing values; invalid, negative and decimal inputs; multiple ingredients; serving fractions; edited products; historical snapshots; and day/week boundaries. Mark cooking and unequal serving assumptions. Reject conversions unsupported by a verified ingredient-specific source. Review rounding strategy and ensure no false target-compliance status due to rounding or unknowns.

## OCR review

Use consented, representative label images and manually verified references kept outside Git. Compare each field and unit, especially serving size and sodium; document omissions, hallucinations and errors. Test clear, small, blurry, curved and multi-panel Thai labels, along with runtime failure. Require visible source image and explicit user correction/confirmation before saving. Treat OCR output as untrusted input. Verify model/runtime licenses and exact versions.

## Release QA and change workflow

Each change has a task, branch, PR, independent reviewer and relevant automated tests; resolve blocking findings before merge. Run unit, integration, accessibility and critical-flow E2E tests as applicable, with evidence in PR. Exercise unauthorized access, upload validation, secrets exclusion, private remote access and restore from an encrypted backup. Test mobile camera, install and usability on actual target devices. For clinical logic, source data, unit conversion and warning changes, block release pending data evidence and required human clinical review. Do not claim validation from synthetic tests alone.
