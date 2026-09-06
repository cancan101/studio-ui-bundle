/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

import { isEmpty, isNil } from 'lodash'
import { type WorkflowDetails } from '../../../shared-tab-manager/tabs/workflow/workflow-api-slice.gen'

export type ActionType = 'transition' | 'global'

interface WorkflowAdditionalField {
  name: string
  fieldType: string
  title: string
  required?: boolean
  fieldTypeSettings?: Record<string, any>
}

interface WorkflowNotes {
  commentEnabled?: boolean
  commentRequired?: boolean
  commentPrefill?: string
  additionalFields?: WorkflowAdditionalField[]
}

/**
 * What to do when a transition is triggered while the element has unsaved changes (transition option
 * `unsavedChangesBehaviour`): refuse with a warning, save the changes as a draft first, or ignore them.
 */
export type WorkflowUnsavedChangesBehaviour = 'warn' | 'save' | 'ignore'

export interface WorkflowAction {
  actionType: ActionType
  workflowId: string
  transitionId: string
  label: string
  notes?: WorkflowNotes
  /** Only set for transitions; global actions have no such option. */
  unsavedChangesBehaviour?: WorkflowUnsavedChangesBehaviour
}

export interface WorkflowActionData {
  workflowOptions?: WorkflowOptions
}

/**
 * The element a workflow action is applied to, plus an optional success side-effect. Supplied via the
 * WorkflowActionSubjectContext so the submit/modal flow is not bound to the element editor: the editor
 * provides it from its element context (with refresh + layout reset as onApplied); other hosts (e.g. the
 * Collab task detail) provide their own element and refetch.
 */
export interface WorkflowActionSubject {
  elementId: number
  elementType: string
  onApplied?: (action: WorkflowAction) => void
  /**
   * Whether the host currently holds unsaved changes for the element. Consulted for the transition's
   * `unsavedChangesBehaviour`; a host that cannot tell leaves it undefined (changes are then ignored).
   */
  hasUnsavedChanges?: () => boolean
  /**
   * Saves the host's unsaved changes as a draft before a transition with `unsavedChangesBehaviour: save`
   * is applied; rejects when saving fails. A host that cannot save leaves it undefined, the behaviour
   * then falls back to `warn`.
   */
  saveUnsavedChanges?: () => Promise<void>
}

export interface WorkflowOptions {
  notes?: string
  additional?: Record<string, any>
}

export type WorkflowActionsList = WorkflowAction[]

interface ActionItem {
  name: string
  label: string
  notes?: WorkflowNotes
  unsavedChangesBehaviour?: string
}

const unsavedChangesBehaviours: WorkflowUnsavedChangesBehaviour[] = ['warn', 'save', 'ignore']

const toUnsavedChangesBehaviour = (value: string | undefined): WorkflowUnsavedChangesBehaviour | undefined =>
  unsavedChangesBehaviours.find((behaviour) => behaviour === value)

const createWorkflowAction = (
  actionType: ActionType,
  workflowName: string,
  item: ActionItem
): WorkflowAction => ({
  actionType,
  workflowId: workflowName,
  transitionId: item.name,
  label: item.label,
  notes: isEmpty(item.notes) ? undefined : item.notes,
  unsavedChangesBehaviour: actionType === 'transition' ? toUnsavedChangesBehaviour(item.unsavedChangesBehaviour) : undefined
})

export const getWorkflowActions = (workflow: WorkflowDetails): WorkflowActionsList => {
  const transitions: WorkflowAction[] = isNil(workflow.allowedTransitions)
    ? []
    : workflow.allowedTransitions.map((transition) =>
        createWorkflowAction('transition', workflow.workflowName, transition as ActionItem)
      )

  const globalActions: WorkflowAction[] = isNil(workflow.globalActions)
    ? []
    : workflow.globalActions.map((action) =>
        createWorkflowAction('global', workflow.workflowName, action as ActionItem)
      )

  return [...transitions, ...globalActions]
}
