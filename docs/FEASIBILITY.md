# M0 feasibility and source register

Status: open. No patient data or label photos belong in GitHub.

| Item | Evidence | Status / next action |
| --- | --- | --- |
| Windows 11, RTX 5070 | User reports Windows 11 and RTX 5070; machine is not connected to this development environment | Record driver, VRAM, runtime and versions on PC; run a local test |
| Typhoon OCR 1.5 3B | [Model card](https://huggingface.co/typhoon-ai/typhoon-ocr1.5-3b-qat) lists Apache-2.0 and requires its OCR prompt; [RTX 50 report](https://github.com/scb-10x/typhoon-ocr/issues/14) concerns RTX 5060 | Check Ollama artifact rights separately; measure field-level extraction on consented Thai label photos on target PC. Human review mandatory |
| Thai food composition data | [Food-data source audit](FOOD_DATA_SOURCE_AUDIT.md): Mahidol Thai FCD v3 (August 2025) is first candidate; FAO SMILING 2013, Open Food Facts and USDA FDC assessed | No data imported. Mahidol permits non-commercial access/use with attribution, but local copy/distribution rights remain unclear; FAO workbook links returned 404 and reuse rights are unknown. Check source-specific limits before import. |
| Branded products | Individual labels and manually entered values | Verify each label and serving unit; keep source/photo private and obtain any required permissions |
| Remote phone access | [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) provides HTTPS to tailnet devices | Proposed only; test authorized and unauthorized access, mobile data, HTTPS, camera, reconnect and PC restart. No Funnel or public Ollama |
| Agent models | Codex desktop currently supports agents, but available model choices depend on environment and account | Verify available roles/models at execution time; do not hardcode an unverified model |
| GitHub CI | Initial checks succeeded | Add integration and end-to-end checks as features arrive |

These sources and model cards are not proof of clinical accuracy or permission to import data. Record specific versions, rights, reviewers and test evidence before acceptance.
