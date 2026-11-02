import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCalculationPayload, isCurrentRevision, nutrients, type FoodState, type Ingredient, type IngredientSource, type NutrientKey, type SavedIngredient, type SavedSeasoning } from './request'
import { ManualIngredientForm } from './ManualIngredientForm'
import { OcrPreview } from './OcrPreview'
import { ProfileManager } from './ProfileManager'
import './style.css'

type Result = {
  experimental: boolean; clinical_use: boolean; rounding: string; portion: string;
  totals: Record<NutrientKey, { value: string | null; complete: boolean }>;
  sources?: Array<{ source_id: string; description: string; source_type: string; source_version: string | null; food_state: FoodState; energy_ambiguous: boolean }>
  saved_sources?: Array<{ version_id: number; name: string; provider: string; source_version: string; source_date: string | null; source_reference: string; provenance: string; retrieved_on: string; food_state: FoodState }>
}
type USDAFood = { fdc_id: number; description: string; source_type: string; source_version: string | null; food_state: FoodState | null }
type FoodTextTranslation = { sourceText: string; translation: string; targetLanguage: 'en' | 'th' }
type SavedRecipeSummary = { id: number; name: string; favorite: boolean }
type SavedRecipeIngredient = {
  ingredient_version_id: number; amount: string; unit: Ingredient['unit']; food_state: FoodState;
  ingredient_name: string; basis_quantity: string; basis_unit: Ingredient['unit']; reviewed: true;
} & Record<NutrientKey, string | null>
type SavedRecipeDetail = SavedRecipeSummary & { ingredients: SavedRecipeIngredient[] }
type USDAIngredientPreview = {
  fdc_id: number; name: string; source_type: 'Foundation' | 'SR Legacy'; source_version: string | null;
  source_date: string | null; food_state: 'raw' | 'cooked'; basis_quantity: '100'; basis_unit: 'g';
  nutrients: Record<NutrientKey, string | null>; snapshot_digest: string;
}
const emptyValues = (): Ingredient['values'] => ({ energy_kcal: '', protein_g: '', sodium_mg: '', potassium_mg: '', phosphorus_mg: '' })
const newIngredient = (): Ingredient => ({ name: '', amount: '', unit: 'g', state: 'raw', reference: '100', values: emptyValues(), source: 'manual', seasoningVersionId: null, ingredientVersionId: null, fdcId: null, fdcState: null })
const stateNames: Record<FoodState, string> = { raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ' }
const foodStateLabel = (state: FoodState | null) => state ? stateNames[state] : 'ระบบระบุสภาพดิบ/สุกไม่ได้ · ยังใช้คำนวณไม่ได้'
const calculationErrorMessages: Record<string, string> = {
  'USDA record does not identify raw or cooked state': 'ระบบระบุสภาพดิบ/สุกจากรายการ USDA นี้ไม่ได้ จึงยังคำนวณไม่ได้ · เลือกรายการที่ระบุสภาพ หรือใช้วัตถุดิบที่บันทึกไว้',
  'Only unbranded USDA Foundation and SR Legacy records are supported': 'รายการ USDA หมวดนี้ยังคำนวณไม่ได้ · เลือกรายการ Foundation หรือ SR Legacy ที่ระบุสภาพอาหาร หรือใช้วัตถุดิบที่บันทึกไว้',
}
// Checked Thai food/condiment terms against Mahidol's ASEAN bilingual tables and
// Department of Health condiment vocabulary. These expand the query only; they
// never translate, rank, or select a USDA record.
const thaiUsdaSearchTerms: Record<string, string> = {
  'อกไก่': 'chicken breast',
  'น่องไก่': 'chicken drumstick',
  'สะโพกไก่': 'chicken thigh',
  'หมูสันใน': 'pork tenderloin',
  'น้ำปลา': 'fish sauce',
  'ซีอิ๊วขาว': 'light soy sauce',
  'ซีอิ๊วดำ': 'dark soy sauce',
  'ซอสหอยนางรม': 'oyster sauce',
  'กะปิ': 'fermented shrimp paste',
}
const broadThaiUsdaSearchChoices: Record<string, string[]> = {
  'ไก่': ['chicken breast', 'chicken thigh', 'chicken drumstick'],
}
const pages = [
  { id: 'home', label: 'หน้าหลัก', compact: 'หน้าแรก' },
  { id: 'patients', label: 'ผู้ป่วย', compact: 'ผู้ป่วย' },
  { id: 'ingredients', label: 'วัตถุดิบและเครื่องปรุง', compact: 'วัตถุดิบ' },
  { id: 'recipes', label: 'สูตรอาหาร', compact: 'สูตรอาหาร' },
  { id: 'meals', label: 'บันทึกอาหาร', compact: 'บันทึก' },
] as const
type PageId = typeof pages[number]['id']

function readPage(fallback: PageId = 'home'): PageId {
  const page = window.location.hash.slice(1)
  return pages.some(item => item.id === page) ? page as PageId : fallback
}

function isSavedRecipeSummary(value: unknown): value is SavedRecipeSummary {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return Number.isInteger(item.id) && Number(item.id) > 0 && typeof item.name === 'string' && typeof item.favorite === 'boolean'
}

function isSavedRecipeDetail(value: unknown): value is SavedRecipeDetail {
  if (!isSavedRecipeSummary(value) || !Array.isArray((value as SavedRecipeDetail).ingredients)) return false
  const ingredients = (value as SavedRecipeDetail).ingredients as unknown[]
  return ingredients.length > 0 && ingredients.every(value => {
    if (!value || typeof value !== 'object') return false
    const item = value as Record<string, unknown>
    return Number.isInteger(item.ingredient_version_id) && Number(item.ingredient_version_id) > 0
      && Number.isFinite(Number(item.amount)) && Number(item.amount) > 0
      && ['g', 'ml'].includes(String(item.unit)) && ['g', 'ml'].includes(String(item.basis_unit))
      && ['raw', 'cooked', 'as_sold'].includes(String(item.food_state))
      && typeof item.ingredient_name === 'string' && Number.isFinite(Number(item.basis_quantity))
      && Number(item.basis_quantity) > 0 && item.reviewed === true
  })
}

function isUSDAIngredientPreview(value: unknown, expectedFdcId: number): value is USDAIngredientPreview {
  if (!value || typeof value !== 'object') return false
  const preview = value as Record<string, unknown>
  if (preview.fdc_id !== expectedFdcId || typeof preview.name !== 'string'
      || !['Foundation', 'SR Legacy'].includes(String(preview.source_type))
      || !['raw', 'cooked'].includes(String(preview.food_state))
      || preview.basis_quantity !== '100' || preview.basis_unit !== 'g'
      || typeof preview.snapshot_digest !== 'string' || !preview.snapshot_digest) return false
  if (!preview.nutrients || typeof preview.nutrients !== 'object') return false
  return nutrients.every(([key]) => {
    const amount = (preview.nutrients as Record<string, unknown>)[key]
    return amount === null || (typeof amount === 'string' && Number.isFinite(Number(amount)) && Number(amount) >= 0)
  })
}

export function App() {
  const [page, setPage] = useState<PageId>(readPage)
  const [ingredientsVisited, setIngredientsVisited] = useState(() => readPage() === 'ingredients')
  const [ingredients, setIngredients] = useState([newIngredient()])
  const [openIngredient, setOpenIngredient] = useState(0)
  const [savedSeasonings, setSavedSeasonings] = useState<SavedSeasoning[]>([])
  const [savedQuery, setSavedQuery] = useState('')
  const [savedIngredients, setSavedIngredients] = useState<SavedIngredient[]>([])
  const [savedSearchBusy, setSavedSearchBusy] = useState(false)
  const [savedSearchError, setSavedSearchError] = useState('')
  const [savedRecipes, setSavedRecipes] = useState<SavedRecipeSummary[]>([])
  const [savedRecipesBusy, setSavedRecipesBusy] = useState(false)
  const [savedRecipesError, setSavedRecipesError] = useState('')
  const [savedRecipeId, setSavedRecipeId] = useState<number | null>(null)
  const [savedRecipeName, setSavedRecipeName] = useState<string | null>(null)
  const [recipeName, setRecipeName] = useState('')
  const [recipeDraftChanged, setRecipeDraftChanged] = useState(false)
  const [recipeSaveBusy, setRecipeSaveBusy] = useState(false)
  const [recipeOpenBusyId, setRecipeOpenBusyId] = useState<number | null>(null)
  const [recipeFavoriteBusyId, setRecipeFavoriteBusyId] = useState<number | null>(null)
  const [recipeStatus, setRecipeStatus] = useState('')
  const [recipeError, setRecipeError] = useState('')
  const [usdaReview, setUsdaReview] = useState<{
    index: number; fdcId: number; data: USDAIngredientPreview | null;
    busy: boolean; saving: boolean; reviewed: boolean; error: string;
  } | null>(null)
  const [seasoningsError, setSeasoningsError] = useState('')
  const [usdaQuery, setUsdaQuery] = useState('')
  const [selectedThaiSearchChoice, setSelectedThaiSearchChoice] = useState('')
  const [translatedQuery, setTranslatedQuery] = useState<FoodTextTranslation | null>(null)
  const [translatedUSDAFoods, setTranslatedUSDAFoods] = useState<Record<number, FoodTextTranslation>>({})
  const [translationBusy, setTranslationBusy] = useState(false)
  const [translationBusyKey, setTranslationBusyKey] = useState('')
  const [translationError, setTranslationError] = useState('')
  const [usdaFoods, setUsdaFoods] = useState<USDAFood[]>([])
  const [usdaError, setUsdaError] = useState('')
  const [usdaBusy, setUsdaBusy] = useState(false)
  const [portion, setPortion] = useState('1')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invalidHandled = useRef(false)
  const revision = useRef(0)
  const usdaReviewRequest = useRef(0)
  const savedSearchRevision = useRef(0)
  const usdaSearchRevision = useRef(0)
  const queryTranslationRevision = useRef(0)
  const translationBusyRef = useRef(false)
  const currentUSDAQuery = useRef('')
  const visibleUSDAFoods = useRef<USDAFood[]>([])
  const ingredientsRef = useRef(ingredients)
  ingredientsRef.current = ingredients
  const normalizedUsdaQuery = usdaQuery.trim().replace(/\s+/g, ' ')
  const queryTranslationTarget: 'en' | 'th' = /[\u0E00-\u0E7F]/.test(normalizedUsdaQuery) ? 'en' : 'th'
  const suggestedUsdaQuery = Object.hasOwn(thaiUsdaSearchTerms, normalizedUsdaQuery) ? thaiUsdaSearchTerms[normalizedUsdaQuery] : undefined
  const broadThaiChoices = Object.hasOwn(broadThaiUsdaSearchChoices, normalizedUsdaQuery) ? broadThaiUsdaSearchChoices[normalizedUsdaQuery] : undefined
  const unsupportedThaiQuery = /[\u0E00-\u0E7F]/.test(normalizedUsdaQuery) && !suggestedUsdaQuery && !broadThaiChoices
  const translatedQueryTooLong = translatedQuery?.targetLanguage === 'en'
    && translatedQuery.translation.trim().length > 200
  const recipeUsesReviewedIngredients = ingredients.length > 0
    && ingredients.every(item => item.source === 'saved' && item.ingredientVersionId !== null)
  const recipeAmountsValid = ingredients.every(item => Number.isFinite(Number(item.amount)) && Number(item.amount) > 0)
  const canSaveRecipe = recipeDraftChanged && recipeUsesReviewedIngredients && recipeAmountsValid && Boolean(recipeName.trim())

  useEffect(() => {
    const syncPage = () => {
      const nextPage = readPage(page)
      setPage(nextPage)
      if (nextPage === 'ingredients') setIngredientsVisited(true)
    }
    window.addEventListener('hashchange', syncPage)
    window.addEventListener('popstate', syncPage)
    return () => {
      window.removeEventListener('hashchange', syncPage)
      window.removeEventListener('popstate', syncPage)
    }
  }, [page])

  useEffect(() => {
    if (page !== 'recipes') return
    void loadSavedRecipes()
    fetch('/experimental/seasonings').then(async response => {
      const payload = await response.json()
      if (!response.ok) throw new Error('โหลดเครื่องปรุงที่บันทึกไว้ไม่ได้')
      setSavedSeasonings((payload.items as SavedSeasoning[]).filter(item => item.reviewed))
      setSeasoningsError('')
    }).catch(() => setSeasoningsError('โหลดเครื่องปรุงที่บันทึกไว้ไม่ได้ ตรวจว่า API ทำงานอยู่บนเครื่องนี้'))
  }, [page])

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, nextPage: PageId) {
    event.preventDefault()
    window.history.pushState(null, '', `#${nextPage}`)
    setPage(nextPage)
    if (nextPage === 'ingredients') setIngredientsVisited(true)
  }

  function clearUSDAReview() {
    usdaReviewRequest.current++
    setUsdaReview(null)
  }

  function update(index: number, changes: Partial<Ingredient>) {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    revision.current++
    if (usdaReview?.index === index) clearUSDAReview()
    setRecipeDraftChanged(true)
    setRecipeStatus('')
    setIngredients(current => current.map((item, i) => i === index ? { ...item, ...changes } : item))
    setResult(null)
  }

  function addIngredient() {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    revision.current++
    clearUSDAReview()
    setRecipeDraftChanged(true)
    setOpenIngredient(ingredients.length)
    setIngredients(items => [...items, newIngredient()])
    setResult(null)
  }

  function removeIngredient(index: number) {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    revision.current++
    clearUSDAReview()
    setRecipeDraftChanged(true)
    const remaining = ingredients.filter((_, i) => i !== index)
    setIngredients(remaining)
    setOpenIngredient(current => current === index ? Math.min(index, remaining.length - 1)
      : current > index ? current - 1 : current)
    setResult(null)
  }

  function selectSeasoning(index: number, versionId: string) {
    if (!versionId) {
      update(index, { ...newIngredient(), amount: ingredients[index].amount, source: 'manual' })
      return
    }
    const seasoning = savedSeasonings.find(item => item.version_id === Number(versionId))
    if (!seasoning) return
    update(index, {
      name: seasoning.name, source: 'seasoning', seasoningVersionId: seasoning.version_id, unit: seasoning.basis_unit,
      ingredientVersionId: null, fdcId: null,
      state: 'as_sold', reference: String(seasoning.basis_quantity),
      values: Object.fromEntries(nutrients.map(([key]) => [key, seasoning.nutrients[key] === null ? '' : String(seasoning.nutrients[key])])) as Ingredient['values'],
    })
  }

  async function searchSavedIngredients() {
    const requestRevision = ++savedSearchRevision.current
    const query = savedQuery.trim()
    setSavedSearchBusy(true); setSavedSearchError(''); setSavedIngredients([])
    try {
      const response = await fetch(`/experimental/ingredients/search?q=${encodeURIComponent(query)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error('ค้นหารายการที่บันทึกไว้ไม่สำเร็จ')
      if (requestRevision === savedSearchRevision.current && query === savedQuery.trim()) {
        setSavedIngredients(payload.items as SavedIngredient[])
      }
    } catch {
      if (requestRevision === savedSearchRevision.current) {
        setSavedSearchError('ค้นหารายการในเครื่องไม่สำเร็จ ตรวจว่า API ทำงานอยู่บนเครื่องนี้')
      }
    } finally {
      if (requestRevision === savedSearchRevision.current) setSavedSearchBusy(false)
    }
  }

  function updateSavedQuery(query: string) {
    savedSearchRevision.current++
    setSavedQuery(query)
    setSavedIngredients([])
    setSavedSearchError('')
    setSavedSearchBusy(false)
  }

  function addSavedIngredient(food: SavedIngredient) {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    revision.current++
    clearUSDAReview()
    setRecipeDraftChanged(true)
    const index = ingredients.length
    setIngredients(current => [...current, { ...newIngredient(), name: food.name,
      source: 'saved', ingredientVersionId: food.version_id, unit: food.basis_unit,
      state: food.food_state, reference: food.basis_quantity,
      values: Object.fromEntries(nutrients.map(([key]) => [key, food.nutrients[key] ?? ''])) as Ingredient['values'] }])
    setOpenIngredient(index)
    setResult(null)
  }

  async function searchUSDA(searchTerm = usdaQuery) {
    const requestRevision = ++usdaSearchRevision.current
    const query = searchTerm.trim()
    if (query.length > 200) {
      setUsdaError('คำค้น USDA ต้องไม่เกิน 200 ตัวอักษร · โปรดแก้คำค้นแล้วลองใหม่')
      return
    }
    visibleUSDAFoods.current = []
    setTranslatedUSDAFoods({})
    setUsdaBusy(true); setUsdaError(''); setTranslationError(''); setUsdaFoods([])
    try {
      const response = await fetch(`/experimental/usda/search?q=${encodeURIComponent(query)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'ค้นหาฐานข้อมูล USDA ไม่สำเร็จ')
      if (requestRevision === usdaSearchRevision.current) {
        visibleUSDAFoods.current = payload.items as USDAFood[]
        setUsdaFoods(payload.items as USDAFood[])
      }
    } catch {
      if (requestRevision === usdaSearchRevision.current) setUsdaError('ค้นหา USDA ไม่สำเร็จ ตรวจ API และ USDA_FDC_API_KEY บนเครื่องนี้')
    } finally {
      if (requestRevision === usdaSearchRevision.current) setUsdaBusy(false)
    }
  }

  function updateUSDAQuery(query: string) {
    usdaSearchRevision.current++
    queryTranslationRevision.current++
    currentUSDAQuery.current = query.trim().replace(/\s+/g, ' ')
    setUsdaQuery(query)
    setSelectedThaiSearchChoice('')
    setTranslatedQuery(null)
    setTranslatedUSDAFoods({})
    setTranslationError('')
    visibleUSDAFoods.current = []
    setUsdaFoods([])
    setUsdaError('')
    setUsdaBusy(false)
  }

  function updateThaiSearchChoice(choice: string) {
    usdaSearchRevision.current++
    queryTranslationRevision.current++
    setSelectedThaiSearchChoice(choice)
    setTranslatedQuery(null)
    setTranslatedUSDAFoods({})
    visibleUSDAFoods.current = []
    setUsdaFoods([])
    setUsdaError('')
    setUsdaBusy(false)
  }

  async function requestLocalFoodTranslation(text: string, targetLanguage: 'en' | 'th', busyKey: string) {
    if (translationBusyRef.current) return null
    translationBusyRef.current = true
    setTranslationBusy(true)
    setTranslationBusyKey(busyKey)
    setTranslationError('')
    try {
      const response = await fetch('/experimental/local-food-translation', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, target_language: targetLanguage }),
      })
      const payload = await response.json()
      if (!response.ok || typeof payload.translation !== 'string') throw new Error('Local translation unavailable')
      setTranslationError('')
      return payload.translation as string
    } catch {
      return null
    } finally {
      translationBusyRef.current = false
      setTranslationBusy(false)
      setTranslationBusyKey('')
    }
  }

  async function translateUSDAQuery() {
    const sourceText = normalizedUsdaQuery
    if (!sourceText) return
    const requestRevision = queryTranslationRevision.current
    const targetLanguage = queryTranslationTarget
    const translation = await requestLocalFoodTranslation(sourceText, targetLanguage, 'query')
    if (requestRevision !== queryTranslationRevision.current || currentUSDAQuery.current !== sourceText) return
    if (!translation) {
      setTranslationError('แปลไม่สำเร็จ · ตรวจการตั้งค่า Ollama และโมเดลแปล แล้วลองอีกครั้ง')
      return
    }
    setTranslatedQuery({ sourceText, translation, targetLanguage })
  }

  async function translateUSDAFood(food: USDAFood) {
    const translation = await requestLocalFoodTranslation(food.description, 'th', String(food.fdc_id))
    const foodStillVisible = visibleUSDAFoods.current.some(item => item.fdc_id === food.fdc_id
      && item.description === food.description)
    if (!foodStillVisible) return
    if (!translation) {
      setTranslationError('แปลไม่สำเร็จ · ตรวจการตั้งค่า Ollama และโมเดลแปล แล้วลองอีกครั้ง')
      return
    }
    {
      setTranslatedUSDAFoods(current => ({
        ...current, [food.fdc_id]: { sourceText: food.description, translation, targetLanguage: 'th' },
      }))
    }
  }

  function selectSource(index: number, source: IngredientSource) {
    const current = ingredients[index]
    if (source === 'manual' && current.source !== 'seasoning') {
      update(index, { ...current, source, seasoningVersionId: null, ingredientVersionId: null,
        fdcId: null, fdcState: null,
        ...(current.source === 'saved' ? { reference: '100', values: emptyValues() } : {}) })
      return
    }
    if (source === 'usda' && current.source === 'manual') {
      update(index, { ...current, source, unit: 'g', seasoningVersionId: null, ingredientVersionId: null, fdcId: null, fdcState: null })
      return
    }
    update(index, { ...newIngredient(), amount: current.amount, source })
  }

  function addUSDAFood(food: USDAFood) {
    const foodState = food.food_state
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving || foodState === null || !['Foundation', 'SR Legacy'].includes(food.source_type)) return
    revision.current++
    clearUSDAReview()
    setRecipeDraftChanged(true)
    const index = ingredients.length
    setIngredients(current => [...current, { ...newIngredient(), source: 'usda', name: food.description,
      fdcId: food.fdc_id, fdcState: foodState, state: foodState }])
    setOpenIngredient(index)
    setResult(null)
  }

  async function loadSavedRecipes() {
    setSavedRecipesBusy(true)
    try {
      const response = await fetch('/experimental/recipes')
      const payload = await response.json()
      if (!response.ok || !Array.isArray(payload.items)) throw new Error('Recipe list unavailable')
      setSavedRecipes(payload.items.filter(isSavedRecipeSummary))
      setSavedRecipesError('')
    } catch {
      setSavedRecipesError('โหลดสูตรที่บันทึกไว้ไม่ได้ · ตรวจว่า API รองรับการบันทึกสูตรและทำงานอยู่บนเครื่องนี้')
    } finally {
      setSavedRecipesBusy(false)
    }
  }

  async function openSavedRecipe(recipeId: number) {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    if (recipeDraftChanged && !window.confirm('เปิดสูตรนี้จะแทนที่รายการและสัดส่วนที่กำลังกรอก หากยังไม่บันทึกให้กดยกเลิกก่อน')) return
    const requestRevision = revision.current
    setRecipeOpenBusyId(recipeId); setRecipeError(''); setRecipeStatus('')
    try {
      const response = await fetch(`/experimental/recipes/${recipeId}`)
      const payload = await response.json()
      if (!response.ok || !isSavedRecipeDetail(payload)) throw new Error('Recipe detail unavailable')
      if (requestRevision !== revision.current) {
        setRecipeStatus('ยังไม่ได้เปิดสูตร เพราะแบบร่างมีการเปลี่ยนแปลงระหว่างโหลด · ลองเปิดอีกครั้ง')
        return
      }
      revision.current++
      setIngredients(payload.ingredients.map(item => ({
        ...newIngredient(), name: item.ingredient_name, amount: item.amount, unit: item.unit,
        state: item.food_state, reference: item.basis_quantity, source: 'saved',
        ingredientVersionId: item.ingredient_version_id,
        values: Object.fromEntries(nutrients.map(([key]) => [key, item[key] ?? ''])) as Ingredient['values'],
      })))
      setRecipeName(payload.name); setSavedRecipeName(payload.name); setSavedRecipeId(payload.id)
      setPortion('1'); setOpenIngredient(0); setResult(null); setError('')
      setRecipeDraftChanged(false); clearUSDAReview()
      setRecipeStatus(`เปิดสูตร “${payload.name}” แล้ว · เปลี่ยนส่วนผสมได้ และกดบันทึกการเปลี่ยนแปลงเมื่อพร้อม`)
    } catch {
      setRecipeError('เปิดสูตรนี้ไม่ได้ · โหลดรายการสูตรใหม่แล้วลองอีกครั้ง')
    } finally {
      setRecipeOpenBusyId(null)
    }
  }

  async function saveRecipe() {
    if (!canSaveRecipe || recipeSaveBusy || recipeOpenBusyId !== null) return
    const name = recipeName.trim()
    const submittedRevision = revision.current
    const recipeIngredients = ingredients.map(item => ({
      ingredient_version_id: item.ingredientVersionId!, amount: item.amount,
      unit: item.unit, food_state: item.state,
    }))
    setRecipeSaveBusy(true); setRecipeError(''); setRecipeStatus('')
    let ingredientsSaved = false
    try {
      let id = savedRecipeId
      if (id === null) {
        const response = await fetch('/experimental/recipes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ synthetic_only: true, name, ingredients: recipeIngredients }),
        })
        const payload = await response.json()
        if (!response.ok || !Number.isInteger(payload.id)) throw new Error('Recipe save failed')
        id = payload.id as number
        setSavedRecipeId(id)
        ingredientsSaved = true
      } else {
        const response = await fetch(`/experimental/recipes/${id}/ingredients`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ synthetic_only: true, ingredients: recipeIngredients }),
        })
        if (!response.ok) throw new Error('Ingredient update failed')
        ingredientsSaved = true
        if (savedRecipeName !== name) {
          const renamed = await fetch(`/experimental/recipes/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ synthetic_only: true, name }),
          })
          if (!renamed.ok) throw new Error('Recipe rename failed')
        }
      }
      const summary = { id, name, favorite: savedRecipes.find(item => item.id === id)?.favorite ?? false }
      setSavedRecipes(current => [summary, ...current.filter(item => item.id !== id)])
      setSavedRecipeName(name)
      if (submittedRevision === revision.current) setRecipeDraftChanged(false)
      setRecipeStatus(savedRecipeId === null ? `บันทึกสูตร “${name}” แล้ว` : `บันทึกการเปลี่ยนแปลงของ “${name}” แล้ว`)
    } catch {
      setRecipeError(ingredientsSaved
        ? 'บันทึกส่วนผสมแล้ว แต่เปลี่ยนชื่อสูตรไม่สำเร็จ · ลองบันทึกอีกครั้ง'
        : 'บันทึกสูตรไม่สำเร็จ · ตรวจการเชื่อมต่อแล้วลองอีกครั้ง')
    } finally {
      setRecipeSaveBusy(false)
    }
  }

  function startNewRecipe() {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    if (recipeDraftChanged && !window.confirm('เริ่มสูตรใหม่จะล้างรายการและสัดส่วนที่กำลังกรอก หากยังไม่บันทึกให้กดยกเลิกก่อน')) return
    revision.current++
    setIngredients([newIngredient()]); setRecipeName(''); setSavedRecipeId(null); setSavedRecipeName(null)
    setPortion('1'); setOpenIngredient(0); setResult(null); setError(''); clearUSDAReview()
    setRecipeDraftChanged(false); setRecipeStatus('เริ่มสูตรใหม่แล้ว'); setRecipeError('')
  }

  async function toggleSavedRecipeFavorite(recipe: SavedRecipeSummary) {
    setRecipeFavoriteBusyId(recipe.id); setRecipeError(''); setRecipeStatus('')
    try {
      const favorite = !recipe.favorite
      const response = await fetch(`/experimental/recipes/${recipe.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, favorite }),
      })
      if (!response.ok) throw new Error('Favorite update failed')
      setSavedRecipes(current => current.map(item => item.id === recipe.id ? { ...item, favorite } : item))
      setRecipeStatus(favorite ? `เพิ่ม “${recipe.name}” ในรายการโปรดแล้ว` : `นำ “${recipe.name}” ออกจากรายการโปรดแล้ว`)
    } catch {
      setRecipeError('เปลี่ยนรายการโปรดไม่สำเร็จ · ลองอีกครั้ง')
    } finally {
      setRecipeFavoriteBusyId(null)
    }
  }

  async function previewUSDAIngredient(index: number) {
    if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
    const ingredient = ingredientsRef.current[index]
    if (ingredient?.source !== 'usda' || ingredient.fdcId === null) return
    const fdcId = ingredient.fdcId
    const requestRevision = revision.current
    const requestId = ++usdaReviewRequest.current
    setUsdaReview({ index, fdcId, data: null, busy: true, saving: false, reviewed: false, error: '' })
    try {
      const response = await fetch('/experimental/ingredients/usda/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, fdc_id: fdcId }),
      })
      const payload = await response.json()
      if (!response.ok || !isUSDAIngredientPreview(payload, fdcId)) throw new Error('Preview unavailable')
      if (requestId !== usdaReviewRequest.current) return
      if (requestRevision !== revision.current || ingredientsRef.current[index]?.source !== 'usda' || ingredientsRef.current[index]?.fdcId !== fdcId) {
        clearUSDAReview()
        return
      }
      setUsdaReview({ index, fdcId, data: payload, busy: false, saving: false, reviewed: false, error: '' })
    } catch {
      if (requestId !== usdaReviewRequest.current) return
      if (requestRevision !== revision.current || ingredientsRef.current[index]?.source !== 'usda' || ingredientsRef.current[index]?.fdcId !== fdcId) {
        clearUSDAReview()
        return
      }
      setUsdaReview({ index, fdcId, data: null, busy: false, saving: false, reviewed: false,
        error: 'ตรวจข้อมูล USDA ไม่สำเร็จ · รายการเดิมยังอยู่ในแบบร่าง ลองอีกครั้ง' })
    }
  }

  async function saveUSDAIngredientReview() {
    const review = usdaReview
    if (!review?.data || !review.reviewed || review.saving) return
    const target = ingredientsRef.current[review.index]
    if (target?.source !== 'usda' || target.fdcId !== review.fdcId) {
      clearUSDAReview()
      return
    }
    setUsdaReview(current => current ? { ...current, saving: true, error: '' } : current)
    try {
      const response = await fetch('/experimental/ingredients/usda', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, reviewed: true, fdc_id: review.fdcId,
          food_state: review.data.food_state, snapshot_digest: review.data.snapshot_digest }),
      })
      if (response.status === 409) {
        setUsdaReview(current => current ? { ...current, data: null, saving: false, reviewed: false,
          error: 'ข้อมูล USDA เปลี่ยนหลังตรวจ · ยังไม่บันทึกและรายการเดิมยังอยู่ในแบบร่าง ลองตรวจข้อมูลใหม่' } : current)
        return
      }
      const payload = await response.json()
      if (!response.ok || !Number.isInteger(payload.version_id)) throw new Error('Snapshot save failed')
      const currentIngredient = ingredientsRef.current[review.index]
      if (currentIngredient?.source !== 'usda' || currentIngredient.fdcId !== review.fdcId) {
        setRecipeStatus('ข้อมูลที่ตรวจแล้วบันทึกในเครื่อง แต่แบบร่างเปลี่ยนระหว่างบันทึก · ตรวจรายการก่อนเลือกใช้')
        clearUSDAReview()
        return
      }
      revision.current++
      setIngredients(current => current.map((item, index) => index === review.index ? {
        ...item, name: review.data!.name, source: 'saved', ingredientVersionId: payload.version_id,
        fdcId: null, fdcState: null, unit: review.data!.basis_unit,
        state: review.data!.food_state, reference: review.data!.basis_quantity,
        values: Object.fromEntries(nutrients.map(([key]) => [key, review.data!.nutrients[key] ?? ''])) as Ingredient['values'],
      } : item))
      setRecipeDraftChanged(true); setResult(null); clearUSDAReview()
      setRecipeStatus(`บันทึกข้อมูล USDA รุ่นที่ตรวจแล้วในเครื่อง · ${review.data.name}`)
    } catch {
      setUsdaReview(current => current ? { ...current, saving: false,
        error: 'บันทึกข้อมูลนี้ไม่สำเร็จ · รายการเดิมยังอยู่ในแบบร่าง ลองตรวจข้อมูลใหม่แล้วบันทึกอีกครั้ง' } : current)
    }
  }

  async function calculate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError(''); setResult(null)
    const submittedRevision = ++revision.current
    try {
      const response = await fetch('/experimental/recipes/calculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCalculationPayload(ingredients, portion)),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'ตรวจข้อมูลแล้วลองอีกครั้ง')
      if (!isCurrentRevision(submittedRevision, revision.current)) return
      setResult(payload as Result)
    } catch (cause) {
      if (isCurrentRevision(submittedRevision, revision.current)) {
        setError(cause instanceof Error && cause.message === 'Failed to fetch'
          ? 'เชื่อมต่อเครื่องคำนวณไม่ได้ ตรวจว่า API ทำงานอยู่บนเครื่องนี้'
          : cause instanceof Error ? calculationErrorMessages[cause.message] ?? cause.message : 'เกิดข้อผิดพลาด')
      }
    } finally { setBusy(false) }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">ข้ามเมนูไปเนื้อหา</a>
    <header className="topbar"><a className="brand" href="#home" onClick={event => navigate(event, 'home')}>ครัวอุ่นใจ <span>เครื่องมือทดลองสำหรับผู้ดูแล</span></a></header>
    <nav className="primary-nav" aria-label="เมนูหลัก">
      {pages.map(item => <a key={item.id} href={`#${item.id}`} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} onClick={event => navigate(event, item.id)}>
        <span className="nav-label-desktop">{item.label}</span><span className="nav-label-mobile" aria-hidden="true">{item.compact}</span>
      </a>)}
    </nav>
    <main id="main-content" tabIndex={-1}>
      {page === 'home' && <section className="home-view" aria-labelledby="home-title">
        <div className="intro"><h1 id="home-title">วางแผนอาหาร<br />ทีละขั้น</h1><p>จัดเก็บข้อมูลเครื่องปรุงที่ตรวจเอง และทดลองคำนวณสูตรอาหาร</p></div>
        <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div><h2>ต้นแบบทดลอง</h2><p>ยังไม่พร้อมใช้กับข้อมูลผู้ป่วยหรือฉลากจริง · ไม่มีการตรวจสอบทางคลินิก</p></div></aside>
        <h2>เริ่มจากเครื่องปรุง</h2>
        <p>ถ่ายหรือเลือกภาพทดสอบ ตรวจค่าที่อ่านได้ แล้วบันทึกเฉพาะหลังตรวจสอบ</p>
        <a className="home-action" href="#ingredients" onClick={event => navigate(event, 'ingredients')}>วัตถุดิบและเครื่องปรุง <span>เพิ่มจากภาพทดสอบ</span></a>
        <a className="home-action" href="#recipes" onClick={event => navigate(event, 'recipes')}>สูตรอาหาร <span>เปิดเครื่องคำนวณทดลอง</span></a>
        <a className="home-action" href="#patients" onClick={event => navigate(event, 'patients')}>โปรไฟล์ข้อมูลสมมติ <span>บันทึกเป้าหมายที่ได้รับและน้ำหนักแห้ง</span></a>
        <h2 className="home-subheading">ส่วนที่กำลังพัฒนา</h2>
        <p>บันทึกอาหารยังไม่มีระบบบันทึก</p>
      </section>}
      {page === 'patients' && <ProfileManager />}
      {ingredientsVisited && <section hidden={page !== 'ingredients'} aria-labelledby="ingredients-title"><div className="page-intro"><h1 id="ingredients-title">วัตถุดิบและเครื่องปรุง</h1><p>การอ่านภาพและบันทึกยังเป็นการทดลอง ใช้ภาพทดสอบเท่านั้น</p></div><OcrPreview /><ManualIngredientForm /></section>}
      {page === 'recipes' && <section aria-labelledby="recipe-title">
        <div className="page-intro"><h1 id="recipe-title">สูตรอาหาร</h1><p>ยังไม่มีสูตรสำเร็จให้เลือกหรือปรับส่วนผสม · สร้างสูตรเองได้โดยเพิ่มวัตถุดิบด้านล่าง</p></div>
        <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div><h2>ใช้ตัวเลขสมมติเท่านั้น</h2><p>ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย ผลนี้ใช้ตัดสินใจด้านอาหารหรือการรักษาไม่ได้</p></div></aside>
        <section className="usda-search" aria-labelledby="saved-recipes-title">
          <h2 id="saved-recipes-title">สูตรที่บันทึกไว้</h2>
          <p>เปิดสูตรเพื่อแก้ส่วนผสม คำนวณใหม่ หรือทำเครื่องหมายรายการโปรด · บันทึกได้เมื่อทุกส่วนผสมใช้วัตถุดิบที่บันทึกและตรวจแล้วในเครื่อง</p>
          <button type="button" className="add-button" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} onClick={startNewRecipe}>เริ่มสูตรใหม่</button>
          {savedRecipesBusy && <p role="status" aria-live="polite">กำลังโหลดสูตรที่บันทึกไว้…</p>}
          {savedRecipesError && <p className="error" role="status">{savedRecipesError} <button type="button" className="thai-query-choice" onClick={() => void loadSavedRecipes()}>โหลดอีกครั้ง</button></p>}
          {!savedRecipesBusy && !savedRecipesError && savedRecipes.length === 0 && <p>ยังไม่มีสูตรที่บันทึกไว้ · เพิ่มวัตถุดิบรุ่นที่ตรวจแล้ว ตั้งชื่อสูตร แล้วบันทึกด้านล่าง</p>}
          <ul className="usda-results">{savedRecipes.map(recipe => <li key={recipe.id}>
            <strong>{recipe.name}</strong><small>{recipe.favorite ? 'อยู่ในรายการโปรด' : 'สูตรที่บันทึกไว้ในเครื่อง'}</small>
            <button type="button" className="add-button" disabled={recipeOpenBusyId !== null || recipeSaveBusy || usdaReview?.saving === true} onClick={() => void openSavedRecipe(recipe.id)}>{recipeOpenBusyId === recipe.id ? 'กำลังเปิด…' : 'เปิดสูตรนี้'}</button>
            <button type="button" className="thai-query-choice" aria-pressed={recipe.favorite} disabled={recipeFavoriteBusyId !== null || recipeSaveBusy || recipeOpenBusyId !== null} onClick={() => void toggleSavedRecipeFavorite(recipe)}>{recipeFavoriteBusyId === recipe.id ? 'กำลังบันทึก…' : recipe.favorite ? 'นำออกจากรายการโปรด' : 'เพิ่มในรายการโปรด'}</button>
          </li>)}</ul>
        </section>
        <form onSubmit={calculate} onInvalidCapture={event => {
          if (invalidHandled.current) return
          invalidHandled.current = true
          const target = event.target as HTMLElement
          const card = target.closest<HTMLElement>('[data-ingredient-index]')
          if (!card) {
            queueMicrotask(() => { invalidHandled.current = false })
            return
          }
          setOpenIngredient(Number(card.dataset.ingredientIndex))
          queueMicrotask(() => {
            target.focus()
            invalidHandled.current = false
          })
        }}>
          <section className="usda-search" aria-label="ค้นหาวัตถุดิบที่บันทึกไว้ในเครื่อง">
            <h2>ค้นหาวัตถุดิบที่บันทึกไว้ในเครื่อง</h2>
            <p>ค้นจากชื่อภาษาไทยหรือชื่อที่บันทึกไว้ในเครื่องนี้เท่านั้น · ไม่ส่งคำค้นออกนอกเครื่อง · แสดงเฉพาะรุ่นที่ผู้ใช้ทำเครื่องหมายว่าตรวจแล้ว ซึ่งไม่ได้ยืนยันความถูกต้องทางคลินิก</p>
            <label>ชื่อที่บันทึกไว้ <input value={savedQuery} onChange={e => updateSavedQuery(e.target.value)} maxLength={100} autoComplete="off" /></label>
            <button type="button" className="add-button" disabled={savedSearchBusy || !savedQuery.trim()} onClick={() => void searchSavedIngredients()}>{savedSearchBusy ? 'กำลังค้นหา…' : 'ค้นหารายการในเครื่อง'}</button>
            {savedSearchError && <p className="error" role="alert">{savedSearchError}</p>}
            <ul className="usda-results">{savedIngredients.map(food => <li key={food.version_id}><strong>{food.name}{food.brand ? ` · ${food.brand}` : ''}</strong><small>รุ่นที่บันทึกไว้ · {food.provider} · {food.source_version} · วันที่แหล่งข้อมูล {food.source_date ?? 'ไม่ระบุ'} · {food.provenance} · สภาพ {stateNames[food.food_state]} · ฐาน {food.basis_quantity} {food.basis_unit === 'g' ? 'กรัม' : 'มล.'} · บันทึก {food.retrieved_on} · {food.source_reference} · รุ่น {food.version_id}</small>
              <button type="button" className="add-button" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} onClick={() => addSavedIngredient(food)}>เลือกเป็นรายการใหม่</button></li>)}</ul>
          </section>
          <section className="usda-search" aria-label="แหล่งข้อมูลรอง USDA">
            <h2>แหล่งข้อมูลรอง: USDA FoodData Central</h2>
            <p>ค้นได้ทั้งวัตถุดิบและอาหารพร้อมรับประทานจาก USDA หมวด Foundation / SR Legacy · ไม่รวมรายการสินค้าแบรนด์ · ผลค้นเป็นข้อมูลของอาหารนั้น ไม่ใช่สูตรหรือรายการส่วนผสม · สูตรที่ทำเองให้เพิ่มวัตถุดิบทีละรายการด้านล่าง · เป็นข้อมูลภาษาอังกฤษ ไม่ใช่การแปลหรือเทียบอาหารไทย · คำค้นถูกส่งไป USDA จึงห้ามใส่ข้อมูลผู้ป่วย</p>
            <label>ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ <input value={usdaQuery} onChange={e => updateUSDAQuery(e.target.value)} maxLength={200} autoComplete="off" /></label>
            <p className="local-translation-note">ส่งเฉพาะคำค้นไปยัง Ollama ที่ตั้งค่า loopback ในเครื่องนี้ · ใช้กับ daemon ที่เชื่อถือได้เท่านั้น · เมื่อยืนยันคำแปลอังกฤษ ระบบส่งข้อความนั้นไปค้น USDA · ห้ามใส่ข้อมูลผู้ป่วย</p>
            <button type="button" className="thai-query-choice" disabled={recipeSaveBusy || !normalizedUsdaQuery || translationBusy} onClick={() => void translateUSDAQuery()}>{translationBusy && translationBusyKey === 'query' ? 'กำลังแปลคำค้น…' : queryTranslationTarget === 'en' ? 'แปลคำค้นไทยเป็นอังกฤษผ่าน Ollama' : 'แปลคำค้นอังกฤษเป็นไทยผ่าน Ollama'}</button>
            {translationBusy && <p role="status" aria-live="polite">กำลังส่งข้อความอาหารไปแปล…</p>}
            {translationError && <p className="error" role="alert">{translationError}</p>}
            {translatedQuery && translatedQuery.sourceText === normalizedUsdaQuery && <div className="thai-query-suggestion" role="status"><span>คำแปลแนะนำจาก Ollama · {translatedQuery.targetLanguage === 'en' ? 'อังกฤษ' : 'ไทย'}</span><strong>{translatedQuery.translation}</strong><small>{translatedQueryTooLong ? 'คำแปลเกินขีดจำกัด USDA 200 ตัวอักษร · ย่อคำค้นแล้วแปลใหม่' : 'เป็นคำช่วยค้นหา/อ่านเท่านั้น · ไม่ยืนยันว่าเป็นอาหารชนิดเดียวกัน · ตรวจชื่อและสภาพ USDA เอง'}</small>{translatedQuery.targetLanguage === 'en' && <button type="button" className="thai-query-choice" disabled={recipeSaveBusy || usdaBusy || translationBusy || translatedQueryTooLong} onClick={() => void searchUSDA(translatedQuery.translation)}>ค้นหา USDA ด้วยคำแปลนี้</button>}</div>}
            {suggestedUsdaQuery && <div className="thai-query-suggestion" role="status"><span>คำค้นอังกฤษแนะนำสำหรับ “{normalizedUsdaQuery}”</span><strong>{suggestedUsdaQuery}</strong><small>คำแนะนำใช้ค้นหาเท่านั้น · ชื่อผลลัพธ์คงตาม USDA</small></div>}
            {broadThaiChoices && <div className="thai-query-suggestion" role="group" aria-label={`เลือกส่วนของอาหารสำหรับ ${normalizedUsdaQuery}`}><span>คำว่า “{normalizedUsdaQuery}” กว้างเกินไป · เลือกส่วนที่ต้องการค้นหา</span>{broadThaiChoices.map(choice => <button type="button" className="thai-query-choice" key={choice} aria-pressed={selectedThaiSearchChoice === choice} onClick={() => updateThaiSearchChoice(choice)}>{choice}</button>)}<small>{selectedThaiSearchChoice ? `เลือกคำค้น: ${selectedThaiSearchChoice}` : 'เลือกคำค้นก่อนค้นหา'} · ชื่อผลลัพธ์คงตาม USDA</small></div>}
            {unsupportedThaiQuery && <p className="thai-query-warning" role="note">ยังไม่มีคำค้นไทยที่ชัดเจนสำหรับคำนี้ · ลองระบุชนิดหรือส่วนอาหารให้ชัดขึ้น</p>}
            <p>ค้นชื่ออาหารภาษาไทยหรืออังกฤษได้ · ตรวจชื่อและสภาพอาหารก่อนเลือก · รายการที่ระบบระบุสภาพดิบ/สุกไม่ได้จะยังเลือกคำนวณไม่ได้</p>
            <button type="button" className="add-button" disabled={recipeSaveBusy || usdaReview?.saving === true || usdaBusy || !usdaQuery.trim() || unsupportedThaiQuery || Boolean(broadThaiChoices && !selectedThaiSearchChoice)} onClick={() => void searchUSDA(selectedThaiSearchChoice || suggestedUsdaQuery || usdaQuery)}>{usdaBusy ? 'กำลังค้นหา…' : suggestedUsdaQuery || selectedThaiSearchChoice ? 'ค้นหา USDA ด้วยคำแนะนำ' : 'ค้นหา USDA'}</button>
            {usdaError && <p className="error" role="alert">{usdaError}</p>}
            <ul className="usda-results">{usdaFoods.map(food => { const supportedSource = food.source_type === 'Foundation' || food.source_type === 'SR Legacy'; return <li key={food.fdc_id}><strong>{food.description}</strong><span className="usda-food-state">สภาพอาหาร: {foodStateLabel(food.food_state)}</span><small>USDA FDC · รายการอ้างอิงไม่ใช่สินค้าแบรนด์ · {food.source_type} · {food.source_version ?? 'รุ่นข้อมูลไม่ระบุ'} · ID {food.fdc_id}</small>
              {translatedUSDAFoods[food.fdc_id]?.sourceText === food.description ? <div className="thai-query-suggestion" role="status"><span>คำแปลช่วยอ่านจาก Ollama</span><strong>{translatedUSDAFoods[food.fdc_id].translation}</strong><small>ชื่อ USDA และสภาพอาหารด้านบนเป็นข้อมูลต้นฉบับ · คำแปลนี้ไม่ยืนยันเอกลักษณ์ของอาหาร</small></div> : <button type="button" className="thai-query-choice" disabled={translationBusy} onClick={() => void translateUSDAFood(food)}>{translationBusy && translationBusyKey === String(food.fdc_id) ? 'กำลังแปลชื่อ…' : 'แปลชื่อ USDA เป็นไทยผ่าน Ollama'}</button>}
              <button type="button" className="add-button" disabled={recipeSaveBusy || usdaReview?.saving === true || !supportedSource || food.food_state === null} onClick={() => addUSDAFood(food)}>{!supportedSource ? 'เลือกไม่ได้ · หมวดนี้ยังไม่รองรับ' : food.food_state === null ? 'เลือกไม่ได้ · ระบุสภาพไม่ได้' : 'เลือกวัตถุดิบนี้'}</button>
              {(!supportedSource || food.food_state === null) && <small className="usda-food-state" role="note">{!supportedSource ? 'ระบบนี้คำนวณได้เฉพาะ USDA Foundation / SR Legacy · ลองเลือกหมวดที่รองรับ หรือใช้วัตถุดิบที่บันทึกไว้' : 'ระบบไม่สามารถระบุจากรายการ USDA นี้ได้ว่าเป็นอาหารดิบหรือสุก จึงยังเลือกคำนวณไม่ได้ · ลองเลือกรายการที่ระบุการปรุงชัดเจน หรือใช้วัตถุดิบที่บันทึกไว้'}</small>}</li> })}</ul>
          </section>
          <section className="section-heading"><h2>รายการวัตถุดิบ</h2><button type="button" className="add-button" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} onClick={addIngredient}>＋ เพิ่มวัตถุดิบ</button></section>
          {ingredients.map((item, index) => <div className="ingredient-card" key={index}>
            <details className="ingredient-details" data-ingredient-index={index} open={openIngredient === index}>
              <summary className="ingredient-summary" onClick={event => {
                event.preventDefault()
                if (!recipeSaveBusy && recipeOpenBusyId === null && !usdaReview?.saving) setOpenIngredient(current => current === index ? -1 : index)
              }}><span>{item.name.trim() || `วัตถุดิบ ${index + 1}`}</span><span>{item.amount ? `${item.amount} ${item.unit === 'g' ? 'กรัม' : 'มล.'}` : 'ยังไม่ระบุปริมาณ'}</span></summary>
              <fieldset className="ingredient-fields" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true}>
            <legend className="visually-hidden">วัตถุดิบ {index + 1}</legend>
            <label>แหล่งข้อมูล <select aria-label={`แหล่งข้อมูลวัตถุดิบ ${index + 1}`} value={item.source} onChange={e => selectSource(index, e.target.value as IngredientSource)}><option value="manual">กรอกข้อมูลเอง</option><option value="usda">USDA รายการอ้างอิง · แหล่งรอง</option><option value="seasoning">เครื่องปรุงที่บันทึกไว้</option><option value="saved" disabled>วัตถุดิบที่บันทึกไว้ · รุ่นที่เลือก</option></select></label>
            {item.source === 'seasoning' && <label>เลือกเครื่องปรุงที่บันทึกไว้ <select value={item.seasoningVersionId ?? ''} onChange={e => selectSeasoning(index, e.target.value)}><option value="">เลือกเครื่องปรุง</option>{savedSeasonings.map(seasoning => <option key={seasoning.version_id} value={seasoning.version_id}>{seasoning.name}{seasoning.brand ? ` · ${seasoning.brand}` : ''} (รุ่น {seasoning.version_id})</option>)}</select></label>}
            {item.source === 'manual' && <label>ชื่อวัตถุดิบ <input value={item.name} onChange={e => update(index, { name: e.target.value })} placeholder="เช่น ข้าวสวย" autoComplete="off" /></label>}
            {item.seasoningVersionId !== null && <p className="footnote">ใช้ข้อมูลที่บันทึกไว้จากรุ่นนี้ ระบบคำนวณจะอ่านค่าจากฐานข้อมูลโดยตรง</p>}
            {item.ingredientVersionId !== null && <p className="footnote">รายการในเครื่อง · รุ่น {item.ingredientVersionId} · แหล่ง/วันที่อ้างอิงแสดงจากรายการค้นหา · คำนวณจะอ่านค่าจากรุ่นนี้ในฐานข้อมูลโดยตรง</p>}
            {item.fdcId !== null && <p className="footnote">USDA FoodData Central · รายการอ้างอิงไม่ใช่สินค้าแบรนด์ · ID {item.fdcId} · สภาพ: {foodStateLabel(item.fdcState)} · ค่ารายละเอียดจะดึงจาก USDA ฝั่งเซิร์ฟเวอร์เมื่อคำนวณ</p>}
            {item.fdcId !== null && <div className="thai-query-suggestion">
              <button type="button" className="thai-query-choice" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true || usdaReview?.busy === true} onClick={() => void previewUSDAIngredient(index)}>{usdaReview?.index === index && usdaReview.fdcId === item.fdcId && usdaReview.busy ? 'กำลังตรวจข้อมูล USDA…' : 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง'}</button>
              {usdaReview?.index === index && usdaReview.fdcId === item.fdcId && item.source === 'usda' && usdaReview.error && <p className="error" role="alert">{usdaReview.error}</p>}
              {usdaReview?.index === index && usdaReview.fdcId === item.fdcId && item.source === 'usda' && usdaReview.data && <div>
                <strong>ตรวจข้อมูลก่อนบันทึก</strong>
                <p>{usdaReview.data.name} · {usdaReview.data.source_type} · {usdaReview.data.source_version ?? 'รุ่นไม่ระบุ'} · วันที่ {usdaReview.data.source_date ?? 'ไม่ระบุ'} · {stateNames[usdaReview.data.food_state]} · ต่อ {usdaReview.data.basis_quantity} กรัม</p>
                <ul>{nutrients.map(([key, label, unit]) => <li key={key}>{label}: {usdaReview.data!.nutrients[key] === null ? 'ไม่ทราบ' : `${usdaReview.data!.nutrients[key]} ${unit}`}</li>)}</ul>
                <label><input type="checkbox" checked={usdaReview.reviewed} disabled={usdaReview.saving} onChange={event => setUsdaReview(current => current ? { ...current, reviewed: event.target.checked } : current)} /> ตรวจชื่อ สภาพ และค่าสารอาหารแล้ว</label>
                <button type="button" className="add-button" disabled={!usdaReview.reviewed || usdaReview.saving} onClick={() => void saveUSDAIngredientReview()}>{usdaReview.saving ? 'กำลังบันทึก…' : 'ยืนยันและบันทึกวัตถุดิบนี้'}</button>
              </div>}
            </div>}
            {item.source === 'usda' && item.fdcId === null && <p className="footnote">ค้นหาอาหารด้านบน แล้วกด “เพิ่มเป็นรายการใหม่” เพื่อเพิ่มรายการ USDA แยกต่างหาก</p>}
            <div className="field-grid">
              <label>ปริมาณที่ใช้ <span className="input-unit"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.amount} onChange={e => update(index, { amount: e.target.value })} placeholder="เช่น 150" /><select aria-label="หน่วยปริมาณ" value={item.unit} disabled={item.source !== 'manual'} onChange={e => update(index, { unit: e.target.value as Ingredient['unit'] })}><option value="g">กรัม</option><option value="ml">มล.</option></select></span></label>
              <label>สภาพอาหาร {item.fdcId !== null ? <span>{foodStateLabel(item.fdcState)}</span> : <select value={item.state} disabled={item.seasoningVersionId !== null || item.ingredientVersionId !== null} onChange={e => update(index, { state: e.target.value as FoodState })}>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</label>
            </div>
            {item.source !== 'usda' && <label>ข้อมูลสารอาหารต่อ <span className="inline-input"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.reference} readOnly={item.source === 'seasoning' || item.source === 'saved'} onChange={e => update(index, { reference: e.target.value })} /><span>{item.unit === 'g' ? 'กรัม' : 'มล.'} (หน่วยเดียวกับปริมาณที่ใช้)</span></span></label>}
            {item.source === 'manual' && <div className="nutrient-grid"><p className="subheading">สารอาหารในปริมาณอ้างอิง <span>เว้นว่างได้เมื่อไม่ทราบ</span></p>
              {nutrients.map(([key, label, unit]) => <label key={key}>{label} <span className="nutrient-unit"><input inputMode="decimal" type="number" min="0" step="any" value={item.values[key]} readOnly={item.seasoningVersionId !== null} onChange={e => update(index, { values: { ...item.values, [key]: e.target.value } })} placeholder="ไม่ทราบ" /><span>{unit}</span></span></label>)}
            </div>}
              </fieldset>
            </details>
            {ingredients.length > 1 && <button type="button" className="remove-button" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} aria-label={`ลบวัตถุดิบ ${index + 1}`} onClick={() => removeIngredient(index)}>ลบ</button>}
          </div>)}
          <section className="usda-search" aria-labelledby="save-recipe-title">
            <h2 id="save-recipe-title">บันทึกสูตรของฉัน</h2>
            {savedRecipeId !== null && <p>กำลังแก้สูตรที่บันทึกไว้ · การแก้ไขในหน้านี้ยังไม่ถูกบันทึก</p>}
            <label htmlFor="recipe-name">ชื่อสูตร <input id="recipe-name" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} value={recipeName} maxLength={150} autoComplete="off" onChange={event => {
              if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return
              revision.current++; setRecipeName(event.target.value); setRecipeDraftChanged(true); setRecipeStatus(''); setRecipeError('')
            }} /></label>
            {!recipeUsesReviewedIngredients && <p role="note">บันทึกสูตรได้เมื่อทุกส่วนผสมเป็นวัตถุดิบที่บันทึกและตรวจแล้ว · รายการกรอกเองและเครื่องปรุงที่บันทึกแยกยังใช้บันทึกสูตรไม่ได้ ส่วน USDA ต้องตรวจข้อมูลและบันทึกเป็นวัตถุดิบในเครื่องก่อน · แบบร่างยังอยู่และคำนวณต่อได้</p>}
            {recipeUsesReviewedIngredients && !recipeAmountsValid && <p role="note">กรอกปริมาณที่มากกว่าศูนย์ในทุกวัตถุดิบก่อนบันทึก</p>}
            {recipeUsesReviewedIngredients && recipeAmountsValid && !recipeName.trim() && <p role="note">ใส่ชื่อสูตรก่อนบันทึก</p>}
            <button type="button" className="submit-button" disabled={!canSaveRecipe || recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} onClick={() => void saveRecipe()}>{recipeSaveBusy ? 'กำลังบันทึก…' : savedRecipeId === null ? 'บันทึกสูตร' : 'บันทึกการเปลี่ยนแปลง'}</button>
          </section>
          <section className="portion-card"><label htmlFor="portion">สัดส่วนของสูตรที่รับประทาน</label><div><input id="portion" disabled={recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true} required inputMode="decimal" type="number" min="0.00000001" max="1" step="any" value={portion} onChange={e => { if (recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving) return; revision.current++; setRecipeDraftChanged(true); setPortion(e.target.value); setResult(null) }} /><span>0.5 = ครึ่งสูตร · 1 = สูตรทั้งหมด</span></div></section>
          <label className="attestation"><input type="checkbox" required /> ยืนยันว่ากำลังทดสอบด้วยสูตรสมมติ ไม่ใช่อาหารหรือข้อมูลผู้ป่วยจริง</label>
          <button className="submit-button" type="submit" disabled={busy || recipeSaveBusy || recipeOpenBusyId !== null || usdaReview?.saving === true}>{busy ? 'กำลังคำนวณ…' : 'คำนวณสารอาหาร'}</button>
        </form>
        {recipeStatus && <p className="status-line" role="status" aria-live="polite">{recipeStatus}</p>}
        {recipeError && <p className="error" role="alert">{recipeError}</p>}
        {seasoningsError && <p className="error" role="status">{seasoningsError}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && <section className="results" aria-live="polite" aria-labelledby="results-title"><div className="result-title"><h2 id="results-title">สารอาหารโดยประมาณ · {result.portion} ของสูตร</h2><span className="status-pill">ไม่ใช่คำแนะนำทางการแพทย์</span></div>
          <ul>{nutrients.map(([key, label, unit]) => { const total = result.totals[key]; return <li key={key}><span>{label}</span><strong>{total.value === null ? 'ไม่ทราบ' : `${total.value} ${unit}`}</strong><small>{total.complete ? 'ข้อมูลครบตามที่กรอก' : 'ข้อมูลไม่ครบ · มีรายการที่ไม่ทราบ'}</small></li> })}</ul>
          {result.sources?.map(source => <p className="footnote" key={source.source_id}>แหล่งข้อมูล USDA อ้างอิงไม่ใช่สินค้าแบรนด์: {source.source_id} · {source.description} · {source.source_type} · สภาพ {stateNames[source.food_state]} · รุ่น {source.source_version ?? 'ไม่ระบุ'}{source.energy_ambiguous ? ' · พลังงานมีหลายค่าขัดแย้ง จึงแสดงเป็นไม่ทราบ' : ''}</p>)}
          {result.saved_sources?.map(source => <p className="footnote" key={source.version_id}>รายการที่บันทึกในเครื่อง รุ่น {source.version_id}: {source.name} · {source.provider} · {source.source_version} · วันที่แหล่งข้อมูล {source.source_date ?? 'ไม่ระบุ'} · {source.provenance} · {source.source_reference} · บันทึก {source.retrieved_on} · สภาพ {stateNames[source.food_state]}</p>)}
          <p className="footnote">ค่าที่ทราบรวมตามสูตรและสัดส่วนเสิร์ฟ ค่าที่เว้นว่างยังคงเป็น “ไม่ทราบ” ไม่ได้ถือเป็นศูนย์</p>
        </section>}
      </section>}
      {page === 'meals' && <section className="placeholder-page" aria-labelledby="meals-title"><h1 id="meals-title">บันทึกอาหาร</h1><p className="status-line">กำลังพัฒนา</p><p>ยังไม่มีระบบบันทึกมื้ออาหารหรือประวัติการรับประทาน ส่วนนี้ยังไม่เก็บข้อมูล</p></section>}
    </main>
    <footer><p>ข้อมูลทดสอบเท่านั้น · ยังไม่มีการตรวจสอบทางคลินิก · ห้ามใช้ตัดสินใจด้านการรักษา</p></footer>
  </div>
}

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<StrictMode><App /></StrictMode>)
