/**
 * This source file is available under the terms of the
 * Pimcore Open Core License (POCL)
 * Full copyright and license information is available in
 * LICENSE.md which is distributed with this source code.
 *
 *  @copyright  Copyright (c) Pimcore GmbH (https://www.pimcore.com)
 *  @license    Pimcore Open Core License (POCL)
 */

import { injectable } from 'inversify'
import { type ReactElement } from 'react'
import { DynamicTypeFieldFilterAbstract, type AbstractFieldFilterDefinition } from '../../dynamic-type-field-filter-abstract'
import { type FieldFilter } from '@Pimcore/modules/element/listing/decorators/general-filters/context-layer/provider/field-filters/field-filters-provider'
import { container } from '@Pimcore/app/depency-injection'
import { serviceIds } from '@Pimcore/app/config/services/service-ids'

export interface CalculatedValueFieldFilterDefinition extends AbstractFieldFilterDefinition {
  elementType?: string
}

/**
 * Calculated value fields carry their semantic type per field (`elementType`), so the
 * concrete filter is resolved from the field definition instead of being fixed per datatype.
 * Date stays on the string filter until the serialized date format is settled upstream.
 */
@injectable()
export class DynamicTypeFieldFilterCalculatedValue extends DynamicTypeFieldFilterAbstract {
  id = 'calculated-value'

  getDelegate (elementType: string | null | undefined): DynamicTypeFieldFilterAbstract {
    const delegateServiceId = {
      numeric: serviceIds['DynamicTypes/FieldFilter/Number'],
      boolean: serviceIds['DynamicTypes/FieldFilter/BooleanSelect']
    }[elementType ?? ''] ?? serviceIds['DynamicTypes/FieldFilter/String']

    return container.get<DynamicTypeFieldFilterAbstract>(delegateServiceId)
  }

  getFieldFilterType (): string {
    // Only meaningful per field; transformFilterToApiRequest resolves the real type.
    return ''
  }

  getFieldFilterComponent (props: CalculatedValueFieldFilterDefinition): ReactElement<CalculatedValueFieldFilterDefinition> {
    return this.getDelegate(props.elementType).getFieldFilterComponent(props) as ReactElement<CalculatedValueFieldFilterDefinition>
  }

  shouldApply (filter: FieldFilter): boolean {
    return this.getDelegateForFilter(filter).shouldApply(filter)
  }

  transformFilterToApiRequest (filter: FieldFilter): FieldFilter {
    return this.getDelegateForFilter(filter).transformFilterToApiRequest(filter)
  }

  private getDelegateForFilter (filter: FieldFilter): DynamicTypeFieldFilterAbstract {
    return this.getDelegate(filter.meta?.fieldDefinition?.elementType as string | undefined)
  }
}
