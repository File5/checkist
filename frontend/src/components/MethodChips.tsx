import { methodLabels, paymentMethods, rememberMethod } from '../lib/payment-methods'
import type { PaymentMethodValue } from '../lib/payment-methods'
import './ChipScroller.css'
import './MethodChips.css'

/** «Kaspi Gold · ForteBank · Наличные · Другая карта»: an optional choice, the pressed chip again — «не указан». The choice
 * is remembered on this device as the default of the next form (`lib/payment-methods.ts`). */
export default function MethodChips({ value, onChange, labelledBy }: {
  value: PaymentMethodValue; onChange: (value: PaymentMethodValue) => void
  /** The id of the visible label of the group. */
  labelledBy: string
}) {
  return <div className="ck-method-chips" role="group" aria-labelledby={labelledBy}>
    {paymentMethods.map((method) => <button key={method} type="button" className="ck-chip" aria-pressed={value === method}
      onClick={() => { const next = value === method ? '' : method; rememberMethod(next); onChange(next) }}>{methodLabels[method]}</button>)}
  </div>
}
