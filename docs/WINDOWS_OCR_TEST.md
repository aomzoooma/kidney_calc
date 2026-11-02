# Windows OCR test handoff

Run on the Windows 11 PC with the RTX 5070 when ready. This is a feasibility test, not a clinical validation. Keep patient data and label photographs outside the repository and do not upload them to GitHub or CI.

1. Open Codex on Windows, authenticate to GitHub as an account with access to `aomzoooma/kidney_calc`, then clone the private repository. Check out the latest `develop`.
2. Record Windows version, GPU name, VRAM, NVIDIA driver and Ollama version. Confirm the model and runtime licenses for the exact artifacts used. Do not paste credentials or private files into logs, issues or PRs.
3. Test `scb10x/typhoon-ocr1.5-3b` with the model provider's OCR prompt and the local Ollama runtime. Check GPU utilization and compare output with the actual label. The known RTX 5060 report is a risk, not a prediction for this PC.
4. Use consented representative labels, including small print, tables, and varied image quality. For each field, compare product name, serving size and unit, energy, protein, sodium, potassium and phosphorus to the label. Mark absent values unknown. Record counts of exact matches, errors, missing fields and unreadable cases without including photographs or personal details.
5. Record model digest, versions, memory usage, latency, failures and reproducible setup. If results repeat characters or fail, stop and report evidence; do not automatically select a replacement model. Manual entry remains necessary.
6. Separately test private HTTPS access from the actual phone over cellular, authentication, camera permissions, restart and reconnect. Do not expose Ollama or the database publicly. Do not configure remote access for real patient data until authentication, backup and security review are complete.

Review outputs with a qualified clinician or renal dietitian before relying on the app for care. The software and workflow are not ready for patient use.
