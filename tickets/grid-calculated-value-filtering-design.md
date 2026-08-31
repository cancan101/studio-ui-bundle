# Design: "Safe for filtering" Calculated Value fields

Implementation design for [`tickets/grid-calculated-value-filtering.md`](./grid-calculated-value-filtering.md) — an opt-in flag by which a developer declares a Calculated Value field to be a pure function of the object's own data, unlocking grid filtering (and sorting) on it in Studio.

All "current state" claims below were verified against the `2026.x` sources of the four repos on 2026-08-27.

---

## 1. Current-state architecture (verified)

### How a calculated value flows today

```
save object
  └─ CalculatedValue::getDataForQueryResource()          [pimcore core]
       → object_query_* table, varchar(columnLength)

index object (generic-data-index-bundle)
  └─ DataObjectNormalizer::normalizeStandardFields()
       ├─ mode 'live'        → $dataObject->get($key)  (runs the calculator)
       └─ mode 'query_store' → CalculatedValueQueryStoreService::getValue()
             (reads the object_query_* snapshot; config:
              pimcore_generic_data_index.calculated_fields_index_mode, default 'live')
       → FieldDefinitionService::normalizeValue()
            adapter locator key 'calculatedValue' → TextKeywordAdapter
            (config/services/search/data-object/field-definition-adapters.yml)
       → indexed as text + keyword  ⟵  ALWAYS a string, regardless of elementType

grid columns (studio-backend-bundle)
  └─ FieldDefinitionCollector → ColumnConfigurationService::buildDataObjectAdapterColumnConfiguration()
       type: 'dataobject.adapter', frontendType: 'calculatedValue'
       config: ['fieldDefinition' => $fieldDefinition]   ⟵ elementType etc. reach the UI
       filterable: CalculatedValueDefinition::isFilterable()  = false   ⟵ THE GATE
       sortable:   CalculatedValueDefinition::isSortable()    = false

grid filters UI (studio-ui-bundle)
  └─ use-field-filter-editor.tsx: resolves FIELD_FILTER type for
     [column.type='dataobject.adapter', column.frontendType='calculatedValue']
       → DynamicTypeFieldFilterObjectAdapter.isFilterAvailable('calculatedValue')
          → ObjectDataRegistry 'calculatedValue' → DynamicTypeObjectDataCalculatedValue
             .dynamicTypeFieldFilterType = (inherited) FieldFilter/None
          → isFilterAvailable() = false  ⟵ column never offered as a filter
     (NB: the backend's `filterable` flag on the column is currently ignored by the UI)

grid filter application (studio-backend-bundle)
  └─ columnFilters [{key, type: 'system.string'|'system.number'|…, filterValue}]
       StringFilter → $query->wildcardSearch(key, value)
       NumberFilter / DateTimeFilter / BooleanFilter → typed queries on the index field
```

Two conclusions fall out of this:

1. **The values are already in the search index** — the whole `calculated_fields_index_mode` machinery exists. Enabling filtering does not require inventing indexing; it requires (a) removing a deliberate gate and (b) typing the index mapping so non-string comparisons are correct.
2. **The delegation pattern the UI needs already exists** — `DynamicTypeFieldFilterObjectAdapter` delegates per `fieldtype` and hands the filter component/transform the `fieldDefinition` (via `useDynamicFilter().config` and `filter.meta.fieldDefinition`). The calculated value type only has to plug a real filter type into `dynamicTypeFieldFilterType` and delegate once more on `elementType`.

### Why upstream gated it

The persisted/indexed value is a snapshot taken at save/index time. A calculator that depends on time, related objects, or external services produces stale snapshots, so filtering would silently return wrong rows. The gate is correctness-motivated — hence the opt-in *declaration* rather than just flipping the gate.

Note on semantics: core's `CalculatedValue::isFilterable()` returns `true` today, but that method governs the SQL listing API (`filterBy`/`getBy` against the varchar query column) — a different, pre-existing behavior. The new flag is a **new, separate declaration**; we do not repurpose `isFilterable()` (changing it would silently break existing `filterBy` users).

---

## 2. The declaration (pimcore/pimcore)

`models/DataObject/ClassDefinition/Data/CalculatedValue.php`:

```php
/**
 * Declares the calculation a pure function of the object's own persisted data,
 * making the stored/indexed snapshot trustworthy for filtering and sorting.
 *
 * @internal
 */
public bool $safeForFiltering = false;

public function isSafeForFiltering(): bool
{
    return $this->safeForFiltering;
}

public function setSafeForFiltering(bool $safeForFiltering): void
{
    $this->safeForFiltering = $safeForFiltering;
}
```

- Public property → automatically part of the class-definition export/var-export round trip and of the serialized `fieldDefinition` that studio-backend puts into the grid column `config`, i.e. the UI sees it with **no extra plumbing**.
- Default `false` → zero behavior change anywhere until a developer opts in.
- `isFilterable()` unchanged (see semantics note above).

Optional companion (bike-shed with upstream): a marker interface so the contract can live on the calculator class itself —

```php
namespace Pimcore\Model\DataObject\ClassDefinition;

interface PureCalculatorInterface {}
```

with `isSafeForFiltering()` returning `$this->safeForFiltering || is_a($this->calculatorClass, PureCalculatorInterface::class, true)`. Nice-to-have; v1 works without it.

**Docs**: the contract must be documented on the Calculated Value data type page: *pure* = result depends only on the object's own persisted data; the snapshot refreshes on each save of the object (and on reindex); depending on other objects, the clock, or external services disqualifies the field, and wrong filter results are then on the declaration, not on Pimcore.

---

## 3. Typed indexing (pimcore/generic-data-index-bundle)

### 3.1 New `CalculatedValueAdapter`

`src/SearchIndexAdapter/DefaultSearch/DataObject/FieldDefinitionAdapter/CalculatedValueAdapter.php`, registered in `config/services/search/data-object/field-definition-adapters.yml` for key `calculatedValue` (replacing the current `TextKeywordAdapter` registration for that key).

Behavior, keyed on the field definition:

| condition | index mapping | normalize |
|---|---|---|
| not safe-for-filtering (default) | text + keyword (exactly today's `TextKeywordAdapter`) | today's behavior |
| safe + `elementType: numeric` | `float` | cast; non-numeric → `null` |
| safe + `elementType: boolean` | `boolean` | `'', '0', null` → false-ish handling mirroring core `isEmpty()` |
| safe + `elementType: date` | `date` | **v2 — see below** |
| safe + `input`/`textarea`/`html` | text + keyword | string cast |

Sketch:

```php
final class CalculatedValueAdapter extends AbstractAdapter
{
    public function getIndexMapping(): array
    {
        $fd = $this->getCalculatedValueDefinition();

        if (!$fd->isSafeForFiltering()) {
            return $this->textKeywordMapping();
        }

        return match ($fd->getElementType()) {
            'numeric' => ['type' => AttributeType::FLOAT->value],
            'boolean' => ['type' => AttributeType::BOOLEAN->value],
            default   => $this->textKeywordMapping(),
        };
    }

    public function normalize(mixed $value): mixed
    {
        $fd = $this->getCalculatedValueDefinition();

        if (!$fd->isSafeForFiltering()) {
            return parent::normalize($value);
        }

        return match ($fd->getElementType()) {
            'numeric' => is_numeric($value) ? (float) $value : null,
            'boolean' => $value !== null && $value !== '' && $value !== '0' && $value !== false,
            default   => $value === null ? null : (string) $value,
        };
    }
}
```

The typed branches must coerce **strings** robustly: in `query_store` mode the value arrives as the varchar snapshot (`'9'`, `'1'`, `''`), in `live` mode as whatever the calculator returns. Both funnels go through `normalize()`.

Localized calculated fields inherit this for free: `LocalizedFieldsAdapter` resolves child field adapters through the same locator, and `CalculatedValueQueryStoreService` already has `getLocalizedValue()`.

### 3.2 Why gate typed mapping on the flag

Mapping only changes for fields the developer flags → existing installs see no mapping diff, no forced reindex, no risk of live-mode calculators returning non-numeric garbage into a float field they never asked for.

### 3.3 Reindex on flag change

Flipping the flag changes the field's index mapping. GDI already reindexes on class-definition changes (`ClassDefinitionReindexService`, triggered from the class-definition save listener); verify the mapping diff triggers the reindex path for the class index (it compares mappings — a text→float change qualifies). Document that the flag becomes effective after that reindex completes.

### 3.4 Date element type — defer to v2

`getDataForQueryResource()` stores `(string) $data` — the on-disk format of a "date" calculated value depends on what the calculator returns (`Carbon` stringifies to a datetime string, some return timestamps). Until that format is pinned down and normalized, a `date` mapping would be guess-parsing. v1 therefore types `numeric` and `boolean`, leaves `date` on text+keyword (string filter still works), and v2 adds date support after deciding the canonical serialization. This keeps v1 small and un-blocked.

---

## 4. Column exposure (pimcore/studio-backend-bundle)

### 4.1 Per-field filterable/sortable

`CalculatedValueDefinition` currently hardcodes both to `false` and — like all `ColumnDefinitionInterface` implementations — never sees the field definition. Rather than widening the interface for everyone, add an opt-in interface:

```php
namespace Pimcore\Bundle\StudioBackendBundle\Grid\Column;

interface FieldDefinitionAwareColumnDefinitionInterface
{
    public function isFilterableForFieldDefinition(Data $fieldDefinition): bool;

    public function isSortableForFieldDefinition(Data $fieldDefinition): bool;
}
```

`ColumnConfigurationService::buildDataObjectAdapterColumnConfiguration()` (which already holds `$fieldDefinition`) checks `instanceof` and prefers the field-aware answer:

```php
$columnDefinition = $availableColumnDefinitions[$columnDefinitionType];

$filterable = $columnDefinition instanceof FieldDefinitionAwareColumnDefinitionInterface
    ? $columnDefinition->isFilterableForFieldDefinition($fieldDefinition)
    : $columnDefinition->isFilterable();
// analogous for sortable
```

`CalculatedValueDefinition` then implements the new interface:

```php
public function isFilterableForFieldDefinition(Data $fieldDefinition): bool
{
    return $fieldDefinition instanceof CalculatedValue && $fieldDefinition->isSafeForFiltering();
}
// isSortableForFieldDefinition(): same condition
```

No other definition changes; no BC break (interface is additive, everything is `@internal` anyway).

### 4.2 Filter application

Nothing new needed: the UI will send `system.number` / `system.string` / `system.boolean` for these columns (see §5), and the existing `NumberFilter` / `StringFilter` / `BooleanFilter` apply them by column key against the index field — which, after §3, has the right type. Verify in an integration test that:

- `system.number` `= 0` on a flagged numeric calculated field matches only value 0 (the original bug's acceptance case);
- a localized flagged field filters per requested locale (existing locale handling on `ColumnFilter` — no special-casing expected).

Sorting comes along for free once `sortable: true` is reported (grid sort already works by column key against the index).

---

## 5. Filter UI (pimcore/studio-ui-bundle)

### 5.1 New delegating filter type

`assets/js/src/core/modules/element/dynamic-types/definitions/field-filters/types/calculated-value/dynamic-type-field-filter-calculated-value.tsx`:

```tsx
@injectable()
export class DynamicTypeFieldFilterCalculatedValue extends DynamicTypeFieldFilterAbstract {
  id = 'calculated-value'

  private getDelegate (elementType: string | undefined): DynamicTypeFieldFilterAbstract {
    const serviceId = {
      numeric: serviceIds['DynamicTypes/FieldFilter/Number'],
      boolean: serviceIds['DynamicTypes/FieldFilter/BooleanSelect'],
      date: serviceIds['DynamicTypes/FieldFilter/String'],   // v2: Datetime, see design §3.4
    }[elementType ?? 'input'] ?? serviceIds['DynamicTypes/FieldFilter/String']

    return container.get<DynamicTypeFieldFilterAbstract>(serviceId)
  }

  getFieldFilterComponent (props: CalculatedValueFieldFilterProps): ReactElement {
    return this.getDelegate(props.elementType).getFieldFilterComponent(props)
  }

  shouldApply (filter: FieldFilter): boolean {
    return this.getDelegate(filter.meta?.fieldDefinition?.elementType).shouldApply(filter)
  }

  transformFilterToApiRequest (filter: FieldFilter): FieldFilter {
    return this.getDelegate(filter.meta?.fieldDefinition?.elementType).transformFilterToApiRequest(filter)
  }
}
```

Wire-up:

- register in the DI container + `service-ids.ts` (`'DynamicTypes/FieldFilter/CalculatedValue'`) and in the field-filter registry alongside the existing types;
- `DynamicTypeObjectDataCalculatedValue`: `dynamicTypeFieldFilterType = container.get(serviceIds['DynamicTypes/FieldFilter/CalculatedValue'])`.

Everything else rides the existing `dataobject.adapter` path with **zero changes**:

- availability: `DynamicTypeFieldFilterObjectAdapter.isFilterAvailable('calculatedValue')` → our type → `isFilterAvailable()` inherits `true`;
- rendering: the adapter component calls `ComponentRenderer(fieldDefinition)` → our `getFieldFilterComponent` receives the field definition props including `elementType`;
- request building: the adapter delegates `transformFilterToApiRequest(filter)` with `filter.meta.fieldDefinition` populated.

### 5.2 Honor the backend `filterable` flag (the per-field gate)

`GridColumnConfiguration.filterable` already travels to the UI and is currently ignored. In `use-field-filter-editor.tsx` → `availableFilterColumns`, add before the dynamic-type resolution:

```ts
if (column.filterable === false) {
  return false
}
```

This is what makes the gate *per field*: unflagged calculated value columns keep `filterable: false` from §4 and never show up; flagged ones show up and resolve to the delegating filter.

> Audit before merging: enumerate `Grid/Column/Definition/**` in studio-backend for other `isFilterable(): false` types and confirm none of them currently renders a working filter in the UI (i.e., the new check must not take away a filter that works today despite the backend flag). Grep suggests the frontend never reads `filterable`, and types with backend `false` map to `FieldFilter/None` anyway, so the expected diff is zero — verify once in the app.

The same treatment applies to `sortable` only if the grid doesn't already honor it (it does — `column.sortable` is consumed by the sorting decorator).

### 5.3 Class editor checkbox

`assets/js/src/core/modules/field-definitions/dynamic-types/types/data/calculatedValue/field-definition-calculated-value-form-fields.tsx`, inside the non-custom-layout block:

```tsx
<Form.Item
  label={ t('safe-for-filtering') }
  name="safeForFiltering"
  tooltip={ t('safe-for-filtering-tooltip') }  // explains the purity contract
  valuePropName="checked"
>
  <Checkbox />
</Form.Item>
```

plus the two translation keys. (The classic class editor in `admin-ui-classic-bundle` should get the same checkbox eventually — out of scope for this series, tracked as follow-up.)

---

## 6. Delivery plan

Order matters only in that each PR is independently green; the feature activates when all are merged.

| # | Repo | PR content | Depends on |
|---|---|---|---|
| 1 | pimcore/pimcore | `safeForFiltering` property + getter/setter + docs | — |
| 2 | generic-data-index-bundle | `CalculatedValueAdapter` (typed mapping + normalize, flag-gated), adapter registration, reindex-on-flag-change verification, tests | 1 |
| 3 | studio-backend-bundle | `FieldDefinitionAwareColumnDefinitionInterface`, `ColumnConfigurationService` wiring, `CalculatedValueDefinition` implements it, integration test for number/string filter on flagged field | 1 |
| 4 | studio-ui-bundle | delegating filter type + registration, `filterable` gate in filter editor, class-editor checkbox, translations, jest tests | 3 (flag in column config), 1 (form field) |

Each step is a no-op for users until step 4 lands and a field is flagged; there is no migration beyond the (automatic, flag-triggered) class reindex.

### Tests

- **core**: class-definition round trip preserves the flag; default false.
- **GDI**: mapping per elementType×flag matrix; normalize coercion (`'9'`→9.0, `''`→null, non-numeric→null, boolean truth table); localized field path.
- **studio-backend**: column config reports filterable/sortable per flag; `system.number = 0` matches only 0 against a flagged field (regression test for the original #1957 symptom); unflagged field rejected/ignored.
- **studio-ui**: delegate selection per elementType incl. fallback; filter hidden when `filterable === false`; transform produces `system.number` for numeric.

### Acceptance criteria

Unchanged from the ticket: numeric flagged field offers the number filter and `= 0` matches only 0; input flagged field offers the text filter with matches; boolean offers the boolean select; unflagged fields behave exactly as today; flag flip reindexes and then filters correctly.

---

## 7. Open questions (for the upstream issue thread)

1. **Naming** — `safeForFiltering` (this doc) vs `pureCalculation` vs `indexableCalculation`. fashxp's wording was "marking fields safe for filtering", so the doc follows that.
2. **Sorting** — this design lets the same flag enable sorting. Any reason to split the two?
3. **Date elementType** — v2 needs a decision on the canonical serialized form of date calculated values before mapping them as `date` (see §3.4).
4. **Marker interface** (`PureCalculatorInterface`) — worth adding in v1, or keep the surface minimal?
5. **Classic admin** — should `admin-ui-classic-bundle` also gate its (currently misbehaving) calculated value grid filter on the flag? That would turn #1957's classic-side wrong-results into a hidden filter unless flagged — arguably the correct resolution of the original bug.
