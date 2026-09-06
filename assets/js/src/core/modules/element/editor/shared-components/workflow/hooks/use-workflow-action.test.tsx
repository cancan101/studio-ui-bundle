/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
jest.mock('@Pimcore/components/message/useMessage', () => ({
  useMessage: jest.fn()
}))
jest.mock('./use-submit-workflow', () => ({
  useSubmitWorkflow: jest.fn()
}))
jest.mock('./use-workflow-modal-state', () => ({
  useWorkflowModalState: jest.fn()
}))
jest.mock('../provider/workflow-provider', () => ({
  useWorkflowActionSubject: jest.fn()
}))

// eslint-disable-next-line import/first
import { act, renderHook, waitFor } from '@testing-library/react'
// eslint-disable-next-line import/first
import { useMessage } from '@Pimcore/components/message/useMessage'
// eslint-disable-next-line import/first
import { useSubmitWorkflow } from './use-submit-workflow'
// eslint-disable-next-line import/first
import { useWorkflowModalState } from './use-workflow-modal-state'
// eslint-disable-next-line import/first
import { useWorkflowActionSubject } from '../provider/workflow-provider'
// eslint-disable-next-line import/first
import { useWorkflowAction } from './use-workflow-action'
// eslint-disable-next-line import/first
import { type WorkflowAction, type WorkflowActionSubject } from '../types/workflow-types'

const mockUseMessage = useMessage as jest.MockedFunction<any>
const mockUseSubmitWorkflow = useSubmitWorkflow as jest.MockedFunction<any>
const mockUseWorkflowModalState = useWorkflowModalState as jest.MockedFunction<any>
const mockUseWorkflowActionSubject = useWorkflowActionSubject as jest.MockedFunction<any>

const messageError = jest.fn()
const submitWorkflowAction = jest.fn()
const openModal = jest.fn()
const setTriggeredWorkflowAction = jest.fn()

const transition = (unsavedChangesBehaviour?: WorkflowAction['unsavedChangesBehaviour'], notes?: WorkflowAction['notes']): WorkflowAction => ({
  actionType: 'transition',
  workflowId: 'wf',
  transitionId: 'go',
  label: 'Go',
  notes,
  unsavedChangesBehaviour
})

const givenSubject = (subject: Partial<WorkflowActionSubject> | null): void => {
  mockUseWorkflowActionSubject.mockReturnValue(subject === null ? null : { elementId: 42, elementType: 'data-object', ...subject })
}

const trigger = async (action: WorkflowAction): Promise<void> => {
  const { result } = renderHook(useWorkflowAction)
  await act(async () => {
    result.current.triggerAction(action)
  })
}

describe('useWorkflowAction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUseMessage.mockReturnValue({ error: messageError })
    mockUseSubmitWorkflow.mockReturnValue({ submitWorkflowAction, submissionLoading: false })
    mockUseWorkflowModalState.mockReturnValue({ openModal, setTriggeredWorkflowAction })
  })

  it('submits an action without unsavedChangesBehaviour right away', async () => {
    givenSubject({ hasUnsavedChanges: () => true })

    await trigger(transition())

    expect(submitWorkflowAction).toHaveBeenCalledTimes(1)
    expect(messageError).not.toHaveBeenCalled()
  })

  it('submits when the element has no unsaved changes', async () => {
    givenSubject({ hasUnsavedChanges: () => false })

    await trigger(transition('warn'))

    expect(submitWorkflowAction).toHaveBeenCalledTimes(1)
    expect(messageError).not.toHaveBeenCalled()
  })

  it('submits when the host cannot tell whether there are unsaved changes', async () => {
    givenSubject({})

    await trigger(transition('warn'))

    expect(submitWorkflowAction).toHaveBeenCalledTimes(1)
  })

  it('opens the notes modal instead of submitting when notes are enabled', async () => {
    givenSubject({ hasUnsavedChanges: () => false })
    const action = transition('warn', { commentEnabled: true })

    await trigger(action)

    expect(setTriggeredWorkflowAction).toHaveBeenCalledWith(action)
    expect(openModal).toHaveBeenCalledTimes(1)
    expect(submitWorkflowAction).not.toHaveBeenCalled()
  })

  it('warns and does not submit for "warn" while there are unsaved changes', async () => {
    givenSubject({ hasUnsavedChanges: () => true })

    await trigger(transition('warn'))

    expect(messageError).toHaveBeenCalledWith('workflow.unsaved-changes')
    expect(submitWorkflowAction).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
  })

  it('submits for "ignore" while there are unsaved changes', async () => {
    givenSubject({ hasUnsavedChanges: () => true })

    await trigger(transition('ignore'))

    expect(submitWorkflowAction).toHaveBeenCalledTimes(1)
    expect(messageError).not.toHaveBeenCalled()
  })

  it('saves the unsaved changes first for "save" and then submits', async () => {
    const saveUnsavedChanges = jest.fn().mockResolvedValue(undefined)
    givenSubject({ hasUnsavedChanges: () => true, saveUnsavedChanges })

    await trigger(transition('save'))

    await waitFor(() => { expect(submitWorkflowAction).toHaveBeenCalledTimes(1) })
    expect(saveUnsavedChanges).toHaveBeenCalledTimes(1)
    expect(saveUnsavedChanges.mock.invocationCallOrder[0]).toBeLessThan(submitWorkflowAction.mock.invocationCallOrder[0])
    expect(messageError).not.toHaveBeenCalled()
  })

  it('does not submit when saving the unsaved changes fails', async () => {
    const saveUnsavedChanges = jest.fn().mockRejectedValue(new Error('save failed'))
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    givenSubject({ hasUnsavedChanges: () => true, saveUnsavedChanges })

    await trigger(transition('save'))

    await waitFor(() => { expect(messageError).toHaveBeenCalledWith('workflow.unsaved-changes-save-failed') })
    expect(submitWorkflowAction).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to a warning for "save" when the host cannot save', async () => {
    givenSubject({ hasUnsavedChanges: () => true })

    await trigger(transition('save'))

    expect(messageError).toHaveBeenCalledWith('workflow.unsaved-changes')
    expect(submitWorkflowAction).not.toHaveBeenCalled()
  })

  it('submits without a subject', async () => {
    givenSubject(null)

    await trigger(transition('warn'))

    expect(submitWorkflowAction).toHaveBeenCalledTimes(1)
  })
})
