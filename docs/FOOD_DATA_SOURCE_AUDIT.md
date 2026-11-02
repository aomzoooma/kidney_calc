# Food data source audit

Status: research only; no data downloaded into the project or imported. Checked 2026-11-03 against linked source-owner documentation. This is a source and integration audit, not a legal opinion, nutrient-coverage study, or clinical review.

## Decision summary

| Source | Best fit | Rights and access | Evidence limit / decision |
| --- | --- | --- | --- |
| [Mahidol Thai FCD](https://inmu.mahidol.ac.th/thaifcd/) | First candidate for generic Thai foods | Version 3 (August 2025) authorizes free non-commercial access and use with attribution. Reproduction, redistribution, local import/storage, and automated access are not clearly granted by the published wording; ask INMU before copying data into this app or a shipped dataset. | Thai-specific and recently revised, but the portal labels itself “Analyze Data Only.” No public API, bulk download, or app-use permission was verified. |
| [FAO/INFOODS SMILING Thailand 2013](https://www.fao.org/infoods/infoods/tables-and-databases/asia/jp/) | Historical/traceability reference | FAO listing links Table A (142 foods, value-level references) and Table B (142 foods, value-level quality assessment). Reuse license and present download availability are unverified. | Both linked XLSX requests returned 404 during this audit. Older and smaller than Mahidol v3; do not treat it as current coverage. |
| [Open Food Facts (OFF)](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/) | Possible lookup for packaged/barcoded products | OFF documents ODbL for the database, DbCL for individual contents, and CC BY-SA for product photos. Review the linked current terms and obligations before reuse. Do not upload a caregiver’s/private label photo: uploaded images are shared with API users. | Community-entered product records have no accuracy/completeness guarantee. Not a generic Thai ingredient table. API can throttle or return 503; no Thai product coverage or potassium/phosphorus completeness was measured. |
| [USDA FoodData Central (FDC)](https://fdc.nal.usda.gov/api-guide/) | Clearly labeled fallback when no Thai source is available | USDA says data are CC0 and requests source attribution. API requests require a data.gov key; separate dataset downloads are available. | US food records are not Thai equivalents. Match only after a human has checked identity, food state, preparation, formulation, nutrient basis, and portion; retain the USDA ID and release. |

No source currently qualifies for bulk import. Keep manual/user-entered data separate from sourced records, and retain source/version, food state, basis, units, and review status for every sourced record.

## Findings by source

### Mahidol Thai FCD

- The source owner identifies the current portal as **Online version 3, August 2025**. It combines/revises online version 2 and the 2015 and 1999 printed Thai Food Composition Tables. Newly analyzed data are described as generated mainly by INMU laboratories during 1997–2025. The owner provides a citation for this exact version on its [home page](https://inmu.mahidol.ac.th/thaifcd/home).
- The portal heading says **“Analyze Data Only.”** A public API or bulk-data download was not found. The page also has a user-registration form; whether registration is required for every search/export path was not established here.
- Published terms say non-commercial users may access and use data without charge with acknowledgement of INMU as source and copyright holder. The same terms say all rights are reserved, reproduction for resale or other commercial purposes may incur fees, and applications for permission to reproduce, distribute, or otherwise use materials should be sent to INMU. That wording does not clearly authorize copying the database into this app, storing a local mirror, or redistributing records. Get written permission for the intended use before any such action. The source lists `kunchit.jud@mahidol.ac.th` for permission applications.
- Thai relevance is strong by source identity, but that alone does not prove a particular entry matches the ingredient, cultivar, region, raw/cooked state, recipe, or household preparation being planned.
- **Potassium/phosphorus coverage:** not measured. No per-food coverage claim is made. If a field is absent, its value remains unknown, not zero.

### FAO/INFOODS SMILING Thailand 2013

- FAO/INFOODS lists a 2013 Thailand table with **142 foods** in two workbooks: one with references at the value level, another with quality assessment at the value level. This is useful provenance/quality metadata if the source file can be recovered.
- On 2026-11-03, the two XLSX links exposed on the FAO/INFOODS page returned HTTP 404 in the source-page fetch. This records a failed access attempt, not proof that no alternate authorized copy exists. No download was ingested.
- The linked listing did not establish a data reuse license or redistribution permission. Ask the owner/source contact before copying or shipping it.
- It is dated 2013 and contains 142 foods, so it is a small historical reference, not a current comprehensive Thai catalog. Its quality sheet is evidence to inspect, not blanket validation of all entries.
- **Potassium/phosphorus coverage:** not measured because the workbooks were unavailable at the linked URLs. Missing values must remain unknown, not zero.

### Open Food Facts

- OFF documents **API v3.6 as current** and recommends v3 for new integrations; v2 is deprecated but still supported. The current API documentation says structured product search is available through v2; v3 search is not implemented, while full-text search is a separate Search-a-licious service. Recheck before implementation because API versions change.
- Read requests require a descriptive `User-Agent` but not authentication. Published limits are 15 product reads/minute/IP and 10 search requests/minute/IP; global throttling can return HTTP 503. The docs explicitly warn against search-as-you-type and recommend handling network, 429, and 5xx failures.
- OFF says data are voluntarily contributed and offers no assurance that records are accurate, complete, or reliable. Product schema supports nutrient fields per 100 g or serving, plus “prepared” values; those bases and values need validation. Some products can explicitly report that no nutrition data appear on the label. A field omitted from a record is not evidence of zero.
- Licensing is layered: ODbL for the database, DbCL for its contents, and CC BY-SA for product images. The API docs also warn that photos can contain separately protected artwork. Treat image reuse as a distinct rights check. Never send patient/caregiver photos to OFF; image uploads become available to other API users.
- OFF is a possible branded-product lookup, not a source for generic cooked Thai foods. No query set was tested, so Thai barcode/name coverage and K/P completeness remain unknown.

### USDA FoodData Central

- FDC documents **CC0 1.0** for its data and asks users to cite USDA FoodData Central. The API requires a data.gov key in every request; the published default limit is 1,000 requests/hour/IP. FDC also offers CSV/JSON dataset downloads.
- Release dates observed on 2026-11-03: Foundation Foods and Branded Foods **October 2026**; FNDDS **2021–2023** (download release dated October 2024); SR Legacy **April 2018**, final/non-updating. FDC describes Branded Foods as monthly-updated, Foundation Foods as periodically updated, and FNDDS as following two-year NHANES cycles. Store data type and release with any selected record.
- FDC combines distinct data types with different food descriptions, methods, units, portion systems, and update schedules. USDA documentation says portions/weights are unique by data type and new Foundation Foods do not necessarily contain every nutrient. The API guide’s “What’s Available” paragraph still refers to FNDDS 2019–2020, while current help/download pages say 2021–2023; use current data-type docs/download metadata, not that stale paragraph.
- USDA nutrient availability or a matching English name does not establish equivalence to a Thai ingredient or preparation. Do not silently substitute a US raw/cooked/processed food for a Thai one. Show source and match basis, require explicit selection, and retain uncertainty.
- **Potassium/phosphorus coverage:** FDC documents these minerals as nutrient types, but individual records can omit nutrients, especially in Foundation Foods. No representative Thai-match set was evaluated. An absent value remains unknown, not zero.

## Cross-source implementation boundary

- No representative food coverage, source-to-source equivalence, or per-food potassium/phosphorus completeness was tested in this audit. Those remain acceptance work, not assumptions.
- Preserve missingness distinctly from numeric zero. Show incomplete nutrient coverage in any total; do not claim target compliance where a required value is unknown.
- Keep raw, cooked, prepared, as-sold, per-100-g, and per-serving records distinct. Never invent yield/retention, portion conversions, or equivalence mappings.
- Before ingestion, record exact source version/retrieval date, rights basis, food-state/basis fields, nutrient missingness, and review owner. Ask the data owner where the published terms do not clearly permit the intended copy or distribution.
- This audit supplies no renal-diet targets, treatment recommendations, safety claim, or clinical validation.

## Primary references

- [Mahidol Thai FCD home and version/citation/terms](https://inmu.mahidol.ac.th/thaifcd/home) · [terms page](https://inmu.mahidol.ac.th/thaifcd/content/term-and-condition) · [source-of-data appendix](https://inmu.mahidol.ac.th/thaifcd/pdf/Source_of_data.pdf)
- [FAO/INFOODS Asia tables and databases: SMILING Thailand 2013 links](https://www.fao.org/infoods/infoods/tables-and-databases/asia/jp/) · [FAO Thai FCD 2025 directory record](https://www.fao.org/food-composition/tables-and-databases/detail/%28thailand--2025%29-thai-food-composition-database/en)
- [OFF API overview, licensing, data-quality warning, rates, and API versions](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/) · [OFF product schema](https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product/) · [OFF photo-upload license/consent guidance](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorial-uploading-photo-to-a-product/)
- [USDA FDC API guide](https://fdc.nal.usda.gov/api-guide/) · [current dataset releases](https://fdc.nal.usda.gov/download-datasets/) · [FDC help and data dates](https://fdc.nal.usda.gov/help/) · [Foundation Foods nutrient completeness notes](https://fdc.nal.usda.gov/Foundation_Foods_Documentation/)
