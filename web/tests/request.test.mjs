import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/request.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { buildCalculationPayload, isCurrentRevision } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`)

test('payload keeps multiple ingredient measures and sends unknown nutrients as null', () => {
  const values = { energy_kcal: '130', protein_g: '', sodium_mg: '4', potassium_mg: '', phosphorus_mg: '' }
  const ingredients = [
    { name: 'rice', amount: '150', unit: 'g', state: 'cooked', reference: '100', values },
    { name: 'soup', amount: '50', unit: 'ml', state: 'as_sold', reference: '100', values: { ...values, protein_g: '2' } },
  ]
  assert.deepEqual(buildCalculationPayload(ingredients, '0.5'), {
    synthetic_only: true, portion: '0.5', ingredients: [
      { amount: '150', unit: 'g', food_state: 'cooked', reference_quantity: '100', reference_unit: 'g', reference_food_state: 'cooked', energy_kcal: '130', protein_g: null, sodium_mg: '4', potassium_mg: null, phosphorus_mg: null },
      { amount: '50', unit: 'ml', food_state: 'as_sold', reference_quantity: '100', reference_unit: 'ml', reference_food_state: 'as_sold', energy_kcal: '130', protein_g: '2', sodium_mg: '4', potassium_mg: null, phosphorus_mg: null },
    ],
  })
})

test('delayed response is discarded after recipe changes', async () => {
  let currentRevision = 4
  const submittedRevision = currentRevision
  let release
  const pending = new Promise(resolve => { release = resolve }).then(result =>
    isCurrentRevision(submittedRevision, currentRevision) ? result : null,
  )
  currentRevision++
  release({ totals: 'stale' })
  assert.equal(await pending, null)
})
