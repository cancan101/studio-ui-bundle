# [Feature] Allow marking Calculated Value fields as safe for filtering (grid filtering support)

## Context

Upstream issue [pimcore/studio-ui-bundle#1957](https://github.com/pimcore/studio-ui-bundle/issues/1957) ("Filtering Calculated Values on Grid View Does not Work") was closed as *not planned*. In the follow-up discussion ([comment](https://github.com/pimcore/studio-ui-bundle/issues/1957#issuecomment-5426685683)):

> **cancan101**: What about if there was some way to mark the field as safe for filtering / a pure function of the object itself such it would be usable for filtering? We use filtering on calculated fields pretty extensively in the admin-ui.
>
> **fashxp (member)**: There is always the possibility to create custom filters to filter for certain fields. But I like the idea of marking fields save for filtering! Do you want to create a new issue for it?

This ticket is that new feature request. It has been **filed upstream as [pimcore/platform-version#419](https://github.com/pimcore/platform-version/issues/419)** (the change spans four packages, so the platform repo is the home); the draft it was filed from is preserved at the bottom. This document also tracks the implementation across the forks.

> **Implementation design:** see [`grid-calculated-value-filtering-design.md`](./grid-calculated-value-filtering-design.md) for the verified current-state architecture and the concrete change set per repo.

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

## Draft for the upstream issue (filed as pimcore/platform-version#419 on 2026-08-28)

Filed against `pimcore/platform-version` because the change spans four packages (`pimcore/pimcore`, `generic-data-index-bundle`, `studio-backend-bundle`, `studio-ui-bundle`). The draft is self-contained — it names classes, services, and config keys, but references no repository files.

**Title:** Allow marking Calculated Value fields as "safe for filtering" to enable grid filtering in Studio

> ## Feature request
>
> Follow-up to pimcore/studio-ui-bundle#1957 (closed as not planned), where @fashxp suggested opening a dedicated issue for this idea: https://github.com/pimcore/studio-ui-bundle/issues/1957#issuecomment-5426685683. Filing it here rather than on a single bundle because the implementation touches four packages.
>
> ## Problem
>
> Calculated Value fields cannot be filtered (or sorted) in the Studio grid. The underlying reason is a trust problem, not a technical gap: the value available for querying is a snapshot taken when the object was saved or indexed, and Pimcore cannot know whether a given calculator is a pure function of the object's own data. A calculator that depends on the clock, related objects, or external services produces stale snapshots, and filtering on those would silently return wrong rows — so Studio currently disables it wholesale (`CalculatedValueDefinition` in the studio backend reports the column as neither filterable nor sortable).
>
> Many projects rely on filtering calculated fields extensively in the classic admin UI, so this is a real gap when moving to Studio.
>
> ## Proposal
>
> Add an opt-in flag on the Calculated Value field definition — working name `safeForFiltering` — by which the developer declares the calculation to be a pure function of the object's own persisted data. For flagged fields the stored/indexed snapshot is authoritative as of the last save, so the grid can offer filtering and sorting safely. Default `false`, so nothing changes for existing installs until a developer opts in.
>
> ## How it fits the current architecture (verified against the 2026.x sources)
>
> The groundwork mostly exists already:
>
> - Calculated values are **already indexed** by the generic data index: the `pimcore_generic_data_index.calculated_fields_index_mode` setting chooses between running the calculator at index time (`live`) or reading the saved query-table snapshot (`query_store`, via `CalculatedValueQueryStoreService`). However, the field type is mapped through `TextKeywordAdapter`, i.e. always indexed as text/keyword regardless of the field's `elementType` — which is exactly why numeric comparisons can never be correct today (the wrong-type comparison was the visible symptom in pimcore/studio-ui-bundle#1957).
> - The studio backend already sends each grid column's `filterable` flag and full serialized field definition (including `elementType`) to the frontend.
> - The Studio UI already has a delegation mechanism for object-data column filters (the `dataobject.adapter` field-filter type resolves the concrete filter per field type) — calculated value currently resolves to the "none" filter, which hides it from the filter sidebar.
>
> ## Proposed implementation
>
> 1. **pimcore/pimcore** — new `bool $safeForFiltering = false` (plus getter/setter) on the `CalculatedValue` field definition. Deliberately *not* reusing `isFilterable()`: that method governs the SQL listing API (`filterBy`/`getBy`) and already returns `true`, so changing it would break existing code. Optionally a `PureCalculatorInterface` marker so the purity contract can live on the calculator class itself. Documentation spells out the contract: "pure" means the result depends only on the object's own persisted data and is refreshed on each save/reindex.
> 2. **generic-data-index-bundle** — a `CalculatedValueAdapter` replacing the `TextKeywordAdapter` registration for the `calculatedValue` field type. Unflagged fields keep today's text/keyword mapping and behavior (zero mapping diff for existing installs). Flagged fields are mapped per `elementType` — `numeric` → float, `boolean` → boolean — with robust string coercion in `normalize()`, since `query_store` mode delivers varchar snapshots. The mapping change on flagging a field goes through the existing class-definition reindex. (`date` support is a follow-up: the serialized format of date calculated values needs to be pinned down first; until then they stay on the string mapping and text filtering.)
> 3. **studio-backend-bundle** — an additive field-definition-aware column definition interface so `CalculatedValueDefinition` can answer filterable/sortable per field (`true` only when the field is flagged); the column configuration service already holds the field definition at that point. No changes to filter application: the existing `system.number`/`system.string`/`system.boolean` column filters work once the index field is typed correctly.
> 4. **studio-ui-bundle** — a small delegating field-filter type for `calculatedValue` that picks the Number/BooleanSelect/String filter from the field's `elementType`, plugged into the existing `dataobject.adapter` delegation (which already hands the filter component and request transform the field definition); the filter sidebar additionally honors the column's `filterable` flag from the backend (currently ignored); and a "safe for filtering" checkbox on the Calculated Value type in the class editor.
>
> Each step is independently mergeable and a no-op for users until all land and a field is flagged; there is no migration beyond the automatic reindex when a field's flag changes.
>
> ## Acceptance criteria
>
> - A flagged calculated value field with `elementType: numeric` offers the number filter, and `= 0` matches only rows whose computed value is 0 (the failure case from pimcore/studio-ui-bundle#1957).
> - Flagged `input`/`textarea` fields offer the text filter and return matching rows; flagged `boolean` fields offer the boolean filter.
> - Sorting works on flagged fields via the same declaration.
> - Unflagged calculated value fields behave exactly as today.
>
> ## Open questions
>
> - Naming: `safeForFiltering` vs `pureCalculation` vs something else?
> - Should the same flag enable sorting (this proposal says yes), or should the two be separate?
> - Canonical serialization for `date` calculated values, so they can get a proper date mapping in a follow-up?
> - Is the `PureCalculatorInterface` marker worth adding in v1?
> - Should the classic admin UI also gate its calculated value grid filtering on the flag? That would resolve the original wrong-results bug there as well.
>
> I'm happy to work on the PRs if the direction is agreed.
