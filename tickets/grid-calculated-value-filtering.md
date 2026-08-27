# [Feature] Allow marking Calculated Value fields as safe for filtering (grid filtering support)

## Context

Upstream issue [pimcore/studio-ui-bundle#1957](https://github.com/pimcore/studio-ui-bundle/issues/1957) ("Filtering Calculated Values on Grid View Does not Work") was closed as *not planned*. In the follow-up discussion ([comment](https://github.com/pimcore/studio-ui-bundle/issues/1957#issuecomment-5426685683)):

> **cancan101**: What about if there was some way to mark the field as safe for filtering / a pure function of the object itself such it would be usable for filtering? We use filtering on calculated fields pretty extensively in the admin-ui.
>
> **fashxp (member)**: There is always the possibility to create custom filters to filter for certain fields. But I like the idea of marking fields save for filtering! Do you want to create a new issue for it?

This ticket is that new feature request. A ready-to-file draft for the upstream issue is at the bottom; this document also tracks the implementation across the forks.

## The idea

Calculated values are computed at runtime by a calculator class/expression. The computed value *is* persisted to the `object_query_*` table on save (`CalculatedValue::getDataForQueryResource()`), but Pimcore cannot know whether that stored snapshot is trustworthy for querying: a calculator may depend on time, related objects, prices, or other external state, in which case the stored value goes stale and filtering on it would silently return wrong results.

The feature: let the developer **declare** that a calculated field is a *pure function of the object's own data*. For such fields the stored (and indexed) value is authoritative as of the last save, so the grid can safely offer filtering on it — restoring the admin-ui-classic capability that teams rely on ("we use filtering on calculated fields pretty extensively").

## Proposed approach

The implementation spans four repos. Default is opt-in (`false`), so nothing changes for existing installs.

### 1. Core — `pimcore/pimcore`

- Add a boolean setting to the `CalculatedValue` field definition (`models/DataObject/ClassDefinition/Data/CalculatedValue.php`), e.g. `safeForFiltering` (working name; alternatives: `pureCalculation`, `persistedForFiltering`), default `false`.
- `isFilterable()` currently hardcodes `true`; change it to return the flag so every filter-capable consumer (Studio, classic admin grid, custom listings) keys off the declaration.
- Optionally, allow declaring purity in code as well: a marker interface (e.g. `PureCalculatorInterface`) on the calculator class that implies the flag, so the contract lives next to the calculation logic.
- Document the contract clearly: "pure" means the result depends only on the object's own persisted data — the stored value is recomputed on each save of the object and is otherwise assumed current. Depending on other objects, time, or external services disqualifies a field.

### 2. Index — `pimcore/generic-data-index-bundle`

- Index calculated value fields when `safeForFiltering` is set, with the index mapping typed per the field's `elementType` (`numeric` → float, `date` → date, `boolean` → boolean, `input` → keyword/text). Today the value is a `varchar` snapshot; typed mapping is what makes numeric/date comparisons correct (the original #1957 symptom — filtering `= 0` matching `9` — is string-comparison semantics).
- Flipping the flag requires a reindex of the class; hook into the existing class-definition-change reindex handling.

### 3. Studio backend — `pimcore/studio-backend-bundle`

- Grid "available columns" endpoint: report calculated value columns as filterable only when the flag is set, and expose `elementType` in the column config so the UI can pick the right filter widget.
- Accept and translate `system.string` / `system.number` / `system.datetime` / `system.boolean` column filters against the indexed calculated value field.

### 4. Studio UI — `pimcore/studio-ui-bundle` (this repo)

Current state (`2026.x`): `DynamicTypeObjectDataCalculatedValue` (`assets/js/src/core/modules/element/dynamic-types/definitions/objects/data-related/types/dynamic-type-object-data-calculated-value.tsx`) does not set `dynamicTypeFieldFilterType`, so it inherits `DynamicTypes/FieldFilter/None`, whose `isFilterAvailable()` returns `false` — calculated value columns are excluded from the filter sidebar (`use-field-filter-editor.tsx`) and dropped from the `columnFilters` payload (`field-filters-filter.ts`).

- Add a delegating `DynamicTypeFieldFilterCalculatedValue` (under `assets/js/src/core/modules/element/dynamic-types/definitions/field-filters/types/`) that resolves the concrete filter from the column's field definition config:

  | `elementType` | Delegate filter | Backend filter type |
  |---|---|---|
  | `input` | `FieldFilter/String` | `system.string` |
  | `numeric` | `FieldFilter/Number` | `system.number` |
  | `date` | `FieldFilter/Datetime` | `system.datetime` |
  | `boolean` | `FieldFilter/BooleanSelect` | `system.boolean` |

  Note `elementType` is a per-field setting while `dynamicTypeFieldFilterType` is a per-datatype static property, so the delegation must read the column config at the availability check, the filter component render, and `transformFilterToApiRequest`.
- Availability is additionally gated on the column being reported filterable by the backend (i.e. the `safeForFiltering` flag).
- Field definition editor: add the "safe for filtering" checkbox in `assets/js/src/core/modules/field-definitions/dynamic-types/types/data/calculatedValue/field-definition-calculated-value-form-fields.tsx` (classic admin class editor needs the same toggle in `admin-ui-classic-bundle`).

### Acceptance criteria

- A calculated value field marked safe-for-filtering, `elementType: numeric`, offers the number filter in the Studio grid; `= 0` matches only rows whose computed value is 0.
- `input`, `date`, and `boolean` element types offer text/datetime/boolean filters respectively, with correct results.
- Fields without the flag behave exactly as today (no filter offered).
- Flipping the flag triggers/requires the documented reindex path.

## Draft for the upstream issue (paste into pimcore/studio-ui-bundle → New issue)

**Title:** Allow marking Calculated Value fields as "safe for filtering" to enable grid filtering

> ## Feature request
>
> Follow-up to #1957, as suggested by @fashxp in https://github.com/pimcore/studio-ui-bundle/issues/1957#issuecomment-5426685683.
>
> Calculated values cannot currently be filtered in the Studio grid, because Pimcore cannot know whether the value snapshot persisted to `object_query_*` is trustworthy — a calculator may depend on time, related objects, or external state.
>
> **Proposal:** add an opt-in flag on the Calculated Value field definition (e.g. `safeForFiltering`) by which the developer declares the calculation to be a pure function of the object's own data. For such fields the persisted/indexed value is authoritative as of the last save, so grid filtering can be offered safely. We use filtering on calculated fields extensively in the classic admin-ui, and this would restore that capability in Studio in a sound way.
>
> Sketch of the moving parts:
> - `pimcore/pimcore`: new bool on `CalculatedValue` field definition; `isFilterable()` returns it (currently hardcoded `true`). Optionally a `PureCalculatorInterface` marker so the contract can live on the calculator class.
> - `generic-data-index-bundle`: index the field when flagged, mapped per `elementType` (float/date/boolean/keyword) so numeric and date comparisons are typed correctly (the wrong-type comparison was the visible symptom in #1957); flag changes trigger reindex.
> - `studio-backend-bundle`: report the column as filterable (with `elementType` in the config) and translate `system.number`/`system.string`/`system.datetime`/`system.boolean` filters for it.
> - `studio-ui-bundle`: a delegating field-filter type for `calculatedValue` that picks String/Number/Datetime/BooleanSelect from the field's `elementType` (today the type inherits `FieldFilter/None`, so the column is excluded from the filter sidebar); plus the checkbox in the class editor form fields.
>
> Default off, so existing installs are unaffected. I'm happy to work on a PR if the direction is agreed.
