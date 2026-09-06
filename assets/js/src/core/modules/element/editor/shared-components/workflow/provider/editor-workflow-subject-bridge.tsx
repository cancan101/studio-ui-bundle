/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

import React, { useCallback, useMemo } from 'react'
import { useOptionalElementContext } from '@Pimcore/modules/element/hooks/use-element-context'
import { useElementRefresh } from '@sdk/modules/element'
import { useLayoutSelection } from '@Pimcore/modules/data-object/editor/toolbar/context-menu/provider/use-layout-selection'
import { useDataObjectDraft } from '@Pimcore/modules/data-object/hooks/use-data-object-draft'
import { SaveTaskType, useSave as useDataObjectSave } from '@Pimcore/modules/data-object/actions/save/use-save'
import {
  useEditFormContext,
  useOptionalEditFormContext
} from '@Pimcore/modules/data-object/editor/types/object/tab-manager/tabs/edit/providers/edit-form-provider/edit-form-provider'
import {
  useOptionalSaveContext
} from '@Pimcore/modules/data-object/editor/types/object/tab-manager/tabs/edit/providers/save-provider/use-save-context'
import { useDocumentDraft } from '@Pimcore/modules/document/hooks/use-document-draft'
import { useSave as useDocumentSave } from '@Pimcore/modules/document/actions/save/use-save'
import { useAssetDraft } from '@Pimcore/modules/asset/hooks/use-asset-draft'
import { type WorkflowActionSubject } from '../types/workflow-types'
import { WorkflowActionSubjectContext } from './workflow-provider'

type EditorElement = NonNullable<ReturnType<typeof useOptionalElementContext>>

interface EditorWorkflowSubjectBridgeProps {
  children: React.ReactNode
}

interface ElementBridgeProps extends EditorWorkflowSubjectBridgeProps {
  element: EditorElement
}

interface SubjectProviderProps extends EditorWorkflowSubjectBridgeProps {
  subject: WorkflowActionSubject | null
}

const SubjectProvider = ({ subject, children }: SubjectProviderProps): React.JSX.Element => (
  <WorkflowActionSubjectContext.Provider value={ subject }>
    {children}
  </WorkflowActionSubjectContext.Provider>
)

/**
 * The part of the subject every element type shares: the element itself and the success side-effect
 * (refresh the element and, for a data-object, reset the current layout — the exact behaviour the
 * toolbars had before the refactor).
 */
const useBaseSubject = (element: EditorElement): WorkflowActionSubject => {
  const { refreshElement } = useElementRefresh(element.elementType)
  const { setCurrentLayout } = useLayoutSelection()

  return useMemo<WorkflowActionSubject>(() => ({
    elementId: element.id,
    elementType: element.elementType,
    onApplied: () => {
      if (element.elementType === 'data-object') {
        setCurrentLayout(null)
      }
      refreshElement(element.id)
    }
  }), [element, refreshElement, setCurrentLayout])
}

/**
 * Data-object subject that can also save the unsaved changes as a draft. Only rendered inside the
 * data-object editor's SaveProvider and EditFormProvider, which the save relies on.
 */
const DataObjectSavingSubjectBridge = ({ element, children }: ElementBridgeProps): React.JSX.Element => {
  const base = useBaseSubject(element)
  const { dataObject, removeTrackedChanges } = useDataObjectDraft(element.id)
  const { save } = useDataObjectSave()
  const { getModifiedDataObjectAttributes, resetModifiedDataObjectAttributes } = useEditFormContext()
  const isModified = dataObject?.modified === true
  const isPublished = dataObject?.published === true

  const saveUnsavedChanges = useCallback(async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      // `save` only calls `onFinish` when the request succeeded, but resolves in any case (also when the
      // save was merely queued behind a running task), so the callback is the success signal.
      save(
        getModifiedDataObjectAttributes(),
        isPublished ? SaveTaskType.Version : SaveTaskType.Save,
        () => {
          resetModifiedDataObjectAttributes()
          removeTrackedChanges()
          resolve()
        }
      )
        .then(() => { reject(new Error('The unsaved changes of the data object could not be saved')) })
        .catch(reject)
    })
  }, [save, getModifiedDataObjectAttributes, resetModifiedDataObjectAttributes, removeTrackedChanges, isPublished])

  const subject = useMemo<WorkflowActionSubject>(() => ({
    ...base,
    hasUnsavedChanges: () => isModified,
    saveUnsavedChanges
  }), [base, isModified, saveUnsavedChanges])

  return <SubjectProvider subject={ subject }>{children}</SubjectProvider>
}

const DataObjectSubjectBridge = ({ element, children }: ElementBridgeProps): React.JSX.Element => {
  const base = useBaseSubject(element)
  const { dataObject } = useDataObjectDraft(element.id)
  // a detached tab has neither provider — then unsaved changes can only be reported, not saved
  const saveContext = useOptionalSaveContext()
  const editFormContext = useOptionalEditFormContext()
  const canSave = saveContext !== undefined && editFormContext !== undefined
  const isModified = dataObject?.modified === true

  const subject = useMemo<WorkflowActionSubject>(() => ({
    ...base,
    hasUnsavedChanges: () => isModified
  }), [base, isModified])

  if (canSave) {
    return <DataObjectSavingSubjectBridge element={ element }>{children}</DataObjectSavingSubjectBridge>
  }

  return <SubjectProvider subject={ subject }>{children}</SubjectProvider>
}

const DocumentSubjectBridge = ({ element, children }: ElementBridgeProps): React.JSX.Element => {
  const base = useBaseSubject(element)
  const { document, removeTrackedChanges } = useDocumentDraft(element.id)
  const { save } = useDocumentSave()
  const isModified = document?.modified === true
  const isPublished = document?.published === true

  const saveUnsavedChanges = useCallback(async (): Promise<void> => {
    await save(isPublished ? SaveTaskType.Version : SaveTaskType.Save, () => {
      removeTrackedChanges()
    })
  }, [save, removeTrackedChanges, isPublished])

  const subject = useMemo<WorkflowActionSubject>(() => ({
    ...base,
    hasUnsavedChanges: () => isModified,
    saveUnsavedChanges
  }), [base, isModified, saveUnsavedChanges])

  return <SubjectProvider subject={ subject }>{children}</SubjectProvider>
}

/** Assets have no draft save that could be triggered from here, so their unsaved changes can only be reported. */
const AssetSubjectBridge = ({ element, children }: ElementBridgeProps): React.JSX.Element => {
  const base = useBaseSubject(element)
  const { asset } = useAssetDraft(element.id)
  const isModified = asset?.modified === true

  const subject = useMemo<WorkflowActionSubject>(() => ({
    ...base,
    hasUnsavedChanges: () => isModified
  }), [base, isModified])

  return <SubjectProvider subject={ subject }>{children}</SubjectProvider>
}

/**
 * Supplies the {@link WorkflowActionSubject} from the element-editor context — the default when
 * `WorkFlowProvider` is used inside an editor and no explicit `subject` is passed. Isolates the
 * editor-only dependencies (element context, element refresh, data-object layout reset, the editor's
 * unsaved changes and draft save) so the shared submit/modal flow stays element-editor-agnostic.
 */
export const EditorWorkflowSubjectBridge = ({ children }: EditorWorkflowSubjectBridgeProps): React.JSX.Element => {
  const element = useOptionalElementContext()

  if (element === null) {
    return <SubjectProvider subject={ null }>{children}</SubjectProvider>
  }

  switch (element.elementType) {
    case 'data-object':
      return <DataObjectSubjectBridge element={ element }>{children}</DataObjectSubjectBridge>
    case 'document':
      return <DocumentSubjectBridge element={ element }>{children}</DocumentSubjectBridge>
    default:
      return <AssetSubjectBridge element={ element }>{children}</AssetSubjectBridge>
  }
}
