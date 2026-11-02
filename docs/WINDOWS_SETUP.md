# Windows 11 development setup

Status: instructions are not yet tested on the target PC. This sets up the public `develop` checkout for development and a local OCR smoke test. It does not prepare the app for patient data or remote use.

## 1. Clone the public development branch

Open PowerShell and choose a work folder. The repository is public; do not put data, images, database files, or credentials in the checkout.

```powershell
$Repo = 'C:\work\kidney_calc'
New-Item -ItemType Directory -Force (Split-Path $Repo) | Out-Null
git clone --branch develop --single-branch https://github.com/aomzoooma/kidney_calc.git $Repo
Set-Location $Repo
git branch --show-current
git pull --ff-only origin develop
git status --short
```

The branch command should report `develop`; `git status --short` should be empty before local edits. Keep task changes on a separate branch, never commit to `develop` or `main`.

## 2. Install repository dependencies

The CI configuration currently uses Python 3.11. Install that version from [python.org](https://www.python.org/downloads/windows/) if needed. The repo's `requirements.txt` is the source of Python app dependencies; use the web lockfile for frontend dependencies.

```powershell
py -3.11 --version
py -3.11 -m venv .venv
$Python = Join-Path $Repo '.venv\Scripts\python.exe'
& $Python -m pip install --upgrade pip
& $Python -m pip install -r (Join-Path $Repo 'requirements.txt')
& $Python -m unittest discover -s tests -v
```

If PowerShell cannot find `py`, install Python 3.11 and reopen PowerShell. If frontend work is needed, install Node.js 22, then use the checked-in lockfile:

```powershell
npm ci --prefix web
npm run build --prefix web
```

The OCR helper is an optional test-only tool, not an app dependency. Install it only for the separate [OCR smoke test](WINDOWS_OCR_TEST.md); do not add it to `requirements.txt` without review.

To run the API for local development only:

```powershell
& $Python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

The current `/health` route only confirms that the process responds. Do not bind to `0.0.0.0`, forward ports, or expose the API, Ollama, or database to a network. No authenticated patient routes or production setup have been implemented.

## Run the experimental calculator on this PC

This preview accepts invented sample numbers and synthetic TEST ONLY images only. The OCR panel calls local Ollama and displays untrusted text for comparison with the image; it does not save or verify values. It does not save profiles or recipes or support remote phone access. Do not enter real food labels or patient information. See the terms and model gate in [WINDOWS_OCR_TEST.md](WINDOWS_OCR_TEST.md).

Complete the dependency setup above, then open two PowerShell windows in the repository folder. In the first:

```powershell
Set-Location C:\work\kidney_calc
.\.venv\Scripts\python.exe -m uvicorn api.main:app --host 127.0.0.1 --port 8000
```

In the second:

```powershell
Set-Location C:\work\kidney_calc
npm run dev --prefix web
```

Open the local address printed by Vite, usually `http://127.0.0.1:5173/`. Keep both windows open while testing; stop each with Ctrl+C. The frontend development server proxies the experimental calculator to the local API. If either port is occupied, stop and resolve the conflict rather than exposing the service to the network. This preview has not been tested on the target Windows PC.

## 3. Record Windows and GPU facts

Run these commands in PowerShell and keep only the required version/model facts in the handoff. Do not include serial numbers, usernames, unrelated process output, or screenshots.

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
Get-CimInstance Win32_ComputerSystem | ForEach-Object {
    [pscustomobject]@{ TotalMemoryGiB = [math]::Round($_.TotalPhysicalMemory / 1GB, 1) }
}
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
```

If `nvidia-smi` is unavailable, record that it failed and check GPU name/driver in Device Manager. Do not infer VRAM or driver details. Ollama's current Windows documentation lists Windows 10 22H2 or later and NVIDIA driver 551.61 or later as requirements; confirm against the live [Ollama Windows documentation](https://docs.ollama.com/windows), especially if it changes.

## 4. Install and check local Ollama

Install Ollama through the [official Windows download](https://ollama.com/download/windows). Do not use Ollama Cloud for this task. Then verify the installed CLI and local model using the steps in [WINDOWS_OCR_TEST.md](WINDOWS_OCR_TEST.md).

Ollama runs locally at `http://localhost:11434` by default. Keep it bound to the local machine. Never add a cloud endpoint, public bind, API key, or model input containing personal/sensitive information. Read the model-specific terms gate before downloading or testing Typhoon; the model card and linked terms have an unresolved scope conflict described in the OCR handoff.

## 5. Preliminary Tailscale preparation

If preparing the phone for later testing, install Tailscale from its [official Windows instructions](https://tailscale.com/docs/install/windows) and the official phone app store. Sign in only approved devices to the user's tailnet and verify the expected device list. Do not enable Serve or Funnel or publish any local service: authentication, authorization, HTTPS behavior, backup/restore, phone workflow, and threat review are unfinished. This step only prepares private device connectivity; it does not mean remote access is ready.

## 6. Open the checkout in Codex Desktop

Open `C:\work\kidney_calc` as the project folder. Confirm the checkout is on `develop`, read `AGENTS.md` and the applicable milestone docs, and create a task branch before code changes. Keep patient or personal data out of prompts, agent context, repository files, terminal captures, issues, and pull requests.

For the OCR task, use the handoff prompt in [WINDOWS_OCR_TEST.md](WINDOWS_OCR_TEST.md). Return only sanitized environment facts and aggregate synthetic-image field counts. Do not attach images, raw OCR text, truth-sheet values, model logs, account details, or device identifiers.

## Known untested limits

- This setup has not been run on the target Windows 11 PC or RTX 5070; GPU support and speed are unknown until measured there.
- The smoke test uses synthetic images because the applicability of the linked Typhoon terms to local use is unclear. It cannot establish recognition accuracy on real packaging.
- The application is under development, not ready for patient care, and has no authenticated API or approved remote-access setup.
- Tailscale connectivity alone does not provide application authentication, patient-data protection, tested backups, or release approval.
