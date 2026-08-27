# [Grid] Filtering on Calculated Value columns does not work

## Context

Upstream issue: [pimcore/studio-ui-bundle#1957](https://github.com/pimcore/studio-ui-bundle/issues/1957) — "Filtering Calculated Values on Grid View Does not Work" (closed as *not planned*, labeled **PR Welcome**), and the follow-up discussion in [this comment](https://github.com/pimcore/studio-ui-bundle/issues/1957#issuecomment-5426685683).

Reported symptoms:

1. **Numeric calculated values**: filtering a number column for `= 0` returned rows whose value is `9` (the comparison runs against the wrong type).
2. **Input (string) calculated values**: applying a filter returns no results at all, even when matching values exist.

Since upstream closed the issue as PR-welcome, this ticket tracks implementing the fix in the forks.

## Root cause analysis (current `2026.x` code)

### Frontend (`studio-ui-bundle`)

- `assets/js/src/core/modules/element/dynamic-types/definitions/objects/data-related/types/dynamic-type-object-data-calculated-value.tsx` — `DynamicTypeObjectDataCalculatedValue` does **not** set `dynamicTypeFieldFilterType`, so it inherits the default from `DynamicTypeObjectDataAbstract`: `DynamicTypes/FieldFilter/None`.
- `DynamicTypeFieldFilterNone.isFilterAvailable()` returns `false`, so calculated value columns are excluded from the filter sidebar (`use-field-filter-editor.tsx` → `availableFilterColumns`), and `field-filters-filter.ts` drops any such filter when building the `columnFilters` API payload. Net effect: no working filter UI for calculated value columns.
- Other data types wire this correctly, e.g.:
  - `dynamic-type-object-data-input.tsx` → `FieldFilter/String`
  - `dynamic-type-object-data-numeric.tsx` → `FieldFilter/Number`
  - `dynamic-type-object-data-datetime.tsx` → `FieldFilter/Datetime`
  - `dynamic-type-object-data-checkbox.tsx` → `FieldFilter/BooleanSelect`
- Complication: a calculated value's semantic type is a **per-field** setting (`elementType`: `input` | `numeric` | `date` | `boolean`, see `CalculatedValueObjectDataDefinition`), while `dynamicTypeFieldFilterType` is a **per-datatype** static property. A single static mapping is not enough — the filter type must be resolved from the column's field definition config.

### Backend / core (changes land in other repos)

- `pimcore/pimcore` — `models/DataObject/ClassDefinition/Data/CalculatedValue.php`: the computed value is persisted to the `object_query_*` table as `varchar(columnLength)` (`getQueryColumnType()`) regardless of `elementType`, and `isFilterable()` already returns `true`. Server-side, a numeric comparison therefore runs against a string column/field; string-vs-number comparison semantics are the likely source of the "`= 0` matches `9`" symptom.
- The Studio grid's server-side filtering happens in `pimcore/studio-backend-bundle` (column filter handling for `system.string`, `system.number`, …) on top of `pimcore/generic-data-index-bundle` (search index). If the index maps calculated value fields as text/keyword, numeric/date range filters cannot work correctly no matter what the UI sends.

## Proposed approach

### Phase 1 — Frontend: expose the correct filter per `elementType` (this repo)

1. Add a `DynamicTypeFieldFilterCalculatedValue` (new type under `assets/js/src/core/modules/element/dynamic-types/definitions/field-filters/types/`) that **delegates** to the existing filter types based on the column's `elementType` from the field definition config:

   | `elementType` | Delegate filter | Backend filter type |
   |---|---|---|
   | `input` | `FieldFilter/String` | `system.string` |
   | `numeric` | `FieldFilter/Number` | `system.number` |
   | `date` | `FieldFilter/Datetime` | `system.datetime` |
   | `boolean` | `FieldFilter/BooleanSelect` | `system.boolean` |

2. Set `dynamicTypeFieldFilterType` on `DynamicTypeObjectDataCalculatedValue` to this new delegating type, and register it in the DI container (`service-ids.ts`, field-filter registry).
3. Make sure the delegation has access to the column config at the three call sites that currently only consult the static property:
   - availability check in `use-field-filter-editor.tsx` (`isFilterAvailable`),
   - filter component rendering (`getFieldFilterComponent`),
   - request building in `field-filters-filter.ts` (`shouldApply` / `transformFilterToApiRequest`) — the `FieldFilter` object already carries `config`/`meta`, so the delegating type can pick the target type from the column's field definition `elementType`; the signatures may need the column config threaded through where it isn't yet.
4. Fallback: if `elementType` is missing/unknown, delegate to `FieldFilter/String` so filtering at least works for the common case.

### Phase 2 — Verify/fix server-side semantics (upstream repos, tracked here)

5. Verify what the grid "available columns" endpoint returns for calculated value columns (`type`, `frontendType`, config incl. `elementType`) and that `studio-backend-bundle` accepts `system.number` / `system.datetime` / `system.boolean` filters for a calculated value column.
6. Check how `generic-data-index-bundle` maps calculated value fields in the index. If they are indexed as keyword/text, numeric and date filters need either (a) index mapping per `elementType`, or (b) a cast in the filter adapter. Without this, Phase 1 will render the right filter UI but `numeric`/`date` comparisons may still be wrong — this is the server-side half of the upstream bug.
7. Alternative (bigger hammer, probably out of scope): make `CalculatedValue::getQueryColumnType()` in `pimcore/pimcore` reflect `elementType` (e.g. `DOUBLE` for `numeric`), which would fix SQL comparison semantics at the source — but it changes DB schema for existing installs and needs a migration story.

## Acceptance criteria

- A calculated value column with `elementType: numeric` offers the number filter; `= 0` matches only rows whose computed value is 0 (not `9`).
- A calculated value column with `elementType: input` offers the text filter and returns matching rows.
- `date` and `boolean` element types offer datetime/boolean filters respectively.
- Columns with no usable filter degrade gracefully (no crash, filter hidden as today).

## Notes

- Filed as an in-repo document because GitHub Issues are disabled on this fork (and on `cancan101/pimcore`); the sandbox proxy does not permit enabling them via the API. If Issues get enabled on the fork, this content can be filed there verbatim.
