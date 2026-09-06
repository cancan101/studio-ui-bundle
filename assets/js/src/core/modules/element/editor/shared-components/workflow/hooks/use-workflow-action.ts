/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@Pimcore/components/message/useMessage'
import { useWorkflowModalState } from './use-workflow-modal-state'
import { useSubmitWorkflow } from './use-submit-workflow'
import { useWorkflowActionSubject } from '../provider/workflow-provider'
import { type WorkflowAction } from '../types/workflow-types'

interface UseWorkflowActionReturn {
  triggerAction: (action: WorkflowAction) => void
  submissionLoading: boolean
}

export const useWorkflowAction = (): UseWorkflowActionReturn => {
  const { t } = useTranslation()
  const messageApi = useMessage()
  const subject = useWorkflowActionSubject()
  const { openModal, setTriggeredWorkflowAction } = useWorkflowModalState()
  const { submitWorkflowAction, submissionLoading } = useSubmitWorkflow()
  const [isSavingUnsavedChanges, setIsSavingUnsavedChanges] = useState(false)

  /**
   * Applies the transition's `unsavedChangesBehaviour` (same semantics as the classic admin UI):
   * `warn` refuses the action while the element has unsaved changes, `save` stores them as a draft
   * first, `ignore` (or no option, e.g. global actions) proceeds right away. Resolves to whether the
   * action may proceed.
   */
  const handleUnsavedChanges = async (action: WorkflowAction): Promise<boolean> => {
    const behaviour = action.unsavedChangesBehaviour

    if (behaviour === undefined || behaviour === 'ignore' || subject?.hasUnsavedChanges?.() !== true) {
      return true
    }

    if (behaviour === 'save' && subject?.saveUnsavedChanges !== undefined) {
      setIsSavingUnsavedChanges(true)

      try {
        await subject.saveUnsavedChanges()

        return true
      } catch (error) {
        console.error(error)
        void messageApi.error(t('workflow.unsaved-changes-save-failed'))

        return false
      } finally {
        setIsSavingUnsavedChanges(false)
      }
    }

    void messageApi.error(t('workflow.unsaved-changes'))

    return false
  }

  const performAction = async (action: WorkflowAction): Promise<void> => {
    if (!await handleUnsavedChanges(action)) {
      return
    }

    setTriggeredWorkflowAction(action)
    if (action.notes?.commentEnabled === true) {
      openModal()
    } else {
      submitWorkflowAction(action)
    }
  }

  const triggerAction = (action: WorkflowAction): void => {
    performAction(action).catch((error) => { console.error(error) })
  }

  return {
    triggerAction,
    submissionLoading: submissionLoading || isSavingUnsavedChanges
  }
}
