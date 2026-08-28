/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

import { serviceIds } from '@Pimcore/app/config/services/service-ids'
import { type FieldFilter } from '@Pimcore/modules/element/listing/decorators/general-filters/context-layer/provider/field-filters/field-filters-provider'
import { DynamicTypeFieldFilterCalculatedValue } from './dynamic-type-field-filter-calculated-value'

jest.mock('@Pimcore/app/depency-injection', () => ({
  container: {
    get: (id: string) => ({
      id,
      shouldApply: () => true,
      transformFilterToApiRequest: (filter: any) => ({ ...filter, type: id })
    })
  }
}))

const makeFilter = (elementType?: string): FieldFilter => ({
  key: 'myCalculatedField',
  type: 'dataobject.adapter',
  filterValue: 'foo',
  locale: null,
  meta: {
    translationKey: 'myCalculatedField',
    fieldDefinition: { fieldtype: 'calculatedValue', elementType }
  }
})

describe('DynamicTypeFieldFilterCalculatedValue', () => {
  const type = new DynamicTypeFieldFilterCalculatedValue()

  it.each([
    ['numeric', serviceIds['DynamicTypes/FieldFilter/Number']],
    ['boolean', serviceIds['DynamicTypes/FieldFilter/BooleanSelect']],
    ['input', serviceIds['DynamicTypes/FieldFilter/String']],
    ['textarea', serviceIds['DynamicTypes/FieldFilter/String']],
    ['html', serviceIds['DynamicTypes/FieldFilter/String']],
    ['date', serviceIds['DynamicTypes/FieldFilter/String']]
  ])('delegates elementType "%s" to %s', (elementType, expectedServiceId) => {
    expect((type.getDelegate(elementType) as unknown as { id: string }).id).toBe(expectedServiceId)
  })

  it('falls back to the string filter for a missing elementType', () => {
    expect((type.getDelegate(undefined) as unknown as { id: string }).id).toBe(serviceIds['DynamicTypes/FieldFilter/String'])
    expect((type.getDelegate(null) as unknown as { id: string }).id).toBe(serviceIds['DynamicTypes/FieldFilter/String'])
  })

  it('transforms the api request through the delegate resolved from the filter meta', () => {
    const transformed = type.transformFilterToApiRequest(makeFilter('numeric'))
    expect(transformed.type).toBe(serviceIds['DynamicTypes/FieldFilter/Number'])
  })

  it('transforms through the string delegate when the field definition carries no elementType', () => {
    const transformed = type.transformFilterToApiRequest(makeFilter(undefined))
    expect(transformed.type).toBe(serviceIds['DynamicTypes/FieldFilter/String'])
  })
})
