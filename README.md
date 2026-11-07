# Thai Renal Nutrition Planner

Personal-use Thai renal nutrition planner for a caregiver. See [master plan](docs/MASTER_PLAN.md). This project is under development and is not ready for patient care.

For development, create a Python virtual environment and install `requirements.txt`. Run tests with `python -m unittest discover -s tests -v`. Start the local-only API with `uvicorn api.main:app --host 127.0.0.1 --port 8000`; `/health` reports only that the process responds, not that the application is ready for use. Optional local food-name translation setup and model terms are in [docs/LOCAL_FOOD_TRANSLATION.md](docs/LOCAL_FOOD_TRANSLATION.md). Encrypted synthetic export prototype and restore blockers are documented in [docs/BACKUP.md](docs/BACKUP.md); no restore is available and it is not ready for patient data. Clinical validation, mobile UI, OCR, security, full backup/restore, and Windows setup are not complete. Do not enter real patient data.
