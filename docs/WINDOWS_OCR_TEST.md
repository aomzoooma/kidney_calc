# Windows local OCR smoke test

Status: not run on the target PC. This is a local engineering smoke test, not a clinical evaluation or release approval. Use synthetic `TEST ONLY` images for this first run. Do not use patient-associated, personal, sensitive, or unlicensed images.

## Model and terms gate

Use the Ollama release linked from the [official Typhoon OCR model card](https://huggingface.co/typhoon-ai/typhoon-ocr1.5-3b-qat): `scb10x/typhoon-ocr1.5-3b`. The model card says to use its prescribed OCR prompt; the [Ollama listing](https://ollama.com/scb10x/typhoon-ocr1.5-3b) links the [OpenTyphoon Terms and Conditions](https://opentyphoon.ai/tac), which say the terms also govern downloads and third-party access, prohibit personal or sensitive data in input and prohibit competitive benchmarking without prior written consent. The Hugging Face model card identifies its repository license as Apache-2.0. The relationship between that license and the linked terms for offline local use is unclear; do not assume local inference is exempt.

For this smoke test, keep inputs synthetic and clearly marked `TEST ONLY`; do not compare against competing models or publish a benchmark. Before using real packaging images, get clarity on the terms and confirm image-use rights. Never submit any patient-associated or sensitive image. Human review is required for every OCR output; OCR is not nutrition evidence or clinical advice.

## 1. Prepare the local model

Install Ollama for Windows from the [official download page](https://ollama.com/download/windows). In PowerShell, confirm the CLI and download the local model:

```powershell
ollama --version
ollama pull scb10x/typhoon-ocr1.5-3b
ollama list
ollama show scb10x/typhoon-ocr1.5-3b
```

The model download needs internet access. Inference below sends the image to the local Ollama address only (`localhost:11434`); do not use a cloud endpoint. Record Ollama version and model ID/digest shown by the commands.

## 2. Prepare a synthetic field sheet

Create three synthetic label images outside the repository, each visibly marked `TEST ONLY` and containing no real person's name, barcode, account, or photo:

1. Clear Thai and English text with a simple nutrient table.
2. Smaller text and a denser table.
3. A resized or mildly blurred copy of a synthetic table.

Use artificial product names and dummy values solely to check transcription. They are not food composition data, recommendations, or inputs to the app. Before inference, write a private truth sheet for fields actually printed on each image: product name, serving size and unit, energy, protein, sodium, potassium, and phosphorus. Mark a field `not present` when omitted. Keep both images and truth sheet out of the repository, GitHub, Codex prompts, and shared logs.

## 3. Run the official OCR prompt locally

The model card recommends the `typhoon-ocr` helper with a local Ollama base URL. Install it only in the repository virtual environment for this smoke test; it is not an application dependency and must not be added to `requirements.txt` without separate review.

```powershell
$OcrVenv = Join-Path $env:LOCALAPPDATA 'kidney-calc-ocr-venv'
py -3.11 -m venv $OcrVenv
$OcrPython = Join-Path $OcrVenv 'Scripts\python.exe'
& $OcrPython -m pip install typhoon-ocr
& $OcrPython -m pip show typhoon-ocr
```

Then run one image at a time, replacing the path with a synthetic image outside the repository:

```powershell
$Image = 'C:\Users\Public\Documents\ocr-test-only\label-clear.png'
$env:OCR_TEST_IMAGE = $Image
@'
import os
from typhoon_ocr import ocr_document
print(ocr_document(
    os.environ["OCR_TEST_IMAGE"],
    base_url="http://localhost:11434/v1",
    api_key="ollama",
    model="scb10x/typhoon-ocr1.5-3b",
))
'@ | & $OcrPython -
```

Use the helper's model-card prompt as-is. Do not replace it with a nutrition-specific prompt for this run. Keep the printed OCR output local and synthetic only. Do not enable request logging or send raw output, screenshots, images, or truth sheets to an issue or pull request.

## 4. Check the target machine and inference path

Run these in a separate PowerShell window while an image is processing:

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
ollama --version
ollama ps
```

If `nvidia-smi` is not found, record that fact and the GPU/driver visible in Device Manager; do not guess. `ollama ps` indicates whether the model is using GPU or CPU. Capture the installed GPU name, total VRAM, driver version, Windows build, Ollama version, model ID/digest, helper package version, cold-start time, warm-run time, and whether execution used GPU/CPU. Do not capture machine serial numbers, account names, or unrelated system logs.

Run each synthetic image once. If output is a repeated character/string, empty, or clearly corrupt, stop further runs and record only the synthetic case ID and failure type. Do not switch quantization, model, or runtime during this test. A broken result is evidence to investigate, not a reason to silently select another model.

## 5. Score field readback

Compare each output to the private truth sheet manually. For every printed field, record one of: `exact`, `wrong`, `missing`, or `unreadable`; record `not present` separately and exclude it from the denominator. Compare the field value and unit; whitespace-only cleanup is acceptable, but do not treat a changed digit, unit, decimal, or nutrient as exact. Report counts by field as `exact / printed`, plus wrong, missing, and unreadable counts. Keep the score aggregate only; do not paste the text or values into GitHub/Codex.

This measures text readback on synthetic images only. It does not establish performance on real labels, permission to process real images, food-data correctness, medical suitability, or product readiness. No clinical or patient-care decision may rely on this result.

## Tailscale preliminary check

Install Tailscale only from the [official Windows instructions](https://tailscale.com/docs/install/windows) and sign in the Windows PC and intended phone to the authorized tailnet. Check that only expected devices appear in the client/admin device list. Do not configure Tailscale Serve, Funnel, port forwarding, or expose Ollama/database/API: the app has no authenticated patient routes yet. This is only a device enrollment/connectivity preparation; phone access, HTTPS, authorization, camera behavior, restart/reconnect, privacy, and security are untested.

## Codex handoff

Open the public checkout at `C:\work\kidney_calc` in Codex Desktop. Start from the current `develop` branch; do feature work on a separate task branch. Give Codex this instruction:

> Read `AGENTS.md`, `docs/WINDOWS_SETUP.md`, and `docs/WINDOWS_OCR_TEST.md`. Help me record the Windows/Ollama smoke-test outcome using synthetic `TEST ONLY` images only. Do not request, inspect, transmit, or save any personal, sensitive, patient-associated, or unlicensed image. Do not put images, raw OCR, truth-sheet values, account names, or machine identifiers in prompts, files, logs, issues, or pull requests. Report the sanitized environment versions, inference device, cold/warm timings, and per-field aggregate counts. Do not change the model/runtime or claim clinical validity. If a failure occurs, preserve it as a finding and stop.

Record only sanitized aggregate evidence in the task/PR. If a repeat-character failure occurs, include the Ollama/model versions, GPU/driver, synthetic case ID, and the fact it occurred; omit the output itself. The RTX 5060 report is a reason to check, not evidence that the RTX 5070 will behave the same.
