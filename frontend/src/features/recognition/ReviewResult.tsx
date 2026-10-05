import type { NormalizedResult, NormalizedTaxRate } from '../../api/recognition'
import { formatAmount, formatPercent, formatPrice, formatPurchasedOn, formatQuantity } from '../../lib/format'

const missing = 'Не прочитано'
const kinds = { product: 'Товар', service: 'Услуга', deposit: 'Залог', deposit_return: 'Возврат залога' }
const yesNo = (value: boolean | null) => value === null ? missing : value ? 'Да' : 'Нет'
function taxLabel(rate: NormalizedTaxRate) { return rate.kind === null ? missing : rate.kind === 'exempt' ? 'Без налога' : `НДС · ${formatPercent(rate.rate)}` }

export default function ReviewResult({ result }: { result: NormalizedResult | null }) {
  if (!result) return <p>Распознанные данные недоступны. Причины проверки приведены выше.</p>
  const receipt = result.proposed_receipt
  const currency = receipt.currency ?? ''
  const amount = (value: string | null) => value === null ? missing : formatAmount(value, currency)
  return <details className="ck-rec-review" open>
    <summary>Распознанные данные для проверки</summary>
    <p className="ck-rec-note">Это неполный результат распознавания. Редактирование и подтверждение через этот экран пока недоступны.</p>
    <dl className="ck-rec-facts">
      <div><dt>Магазин</dt><dd>{receipt.store_display_name ?? missing}</dd></div>
      <div><dt>Адрес</dt><dd>{receipt.address_display ?? missing}</dd></div>
      <div><dt>Дата на чеке</dt><dd>{receipt.purchased_on === null ? missing : formatPurchasedOn(receipt.purchased_on) === '—' ? receipt.purchased_on : formatPurchasedOn(receipt.purchased_on)}</dd></div>
      <div><dt>Местное время</dt><dd>{receipt.local_time ?? missing}</dd></div>
      <div><dt>Операция</dt><dd>{receipt.operation === null ? missing : receipt.operation === 'sale' ? 'Покупка' : 'Возврат'}</dd></div>
      <div><dt>Валюта</dt><dd>{receipt.currency ?? missing}</dd></div>
      <div><dt>Итого</dt><dd>{amount(receipt.total)}</dd></div>
      <div><dt>Скидка на чек</dt><dd>{amount(receipt.discount_total)}</dd></div>
      <div><dt>Налог включён в цены</dt><dd>{yesNo(receipt.prices_include_tax)}</dd></div>
    </dl>
    <h4>Распознанные строки ({result.lines.length})</h4>
    {result.lines.length === 0 ? <p>Строки не прочитаны.</p> : <ol className="ck-rec-list">{result.lines.map((line, index) => <li className="ck-rec-card" key={index}>
      <p><strong>{line.name ?? missing}</strong> · строка {line.position ?? missing} · {line.kind === null ? missing : kinds[line.kind]}</p>
      <dl className="ck-rec-facts">
        <div><dt>Количество</dt><dd>{line.quantity === null ? missing : formatQuantity(line.quantity, line.unit)}</dd></div>
        <div><dt>Цена за единицу</dt><dd>{line.unit_price === null ? missing : formatPrice(line.unit_price, currency, line.unit)}</dd></div>
        <div><dt>Сумма</dt><dd>{amount(line.amount)}</dd></div>
        <div><dt>Скидка</dt><dd>{amount(line.discount_amount)}</dd></div>
        <div><dt>Налог</dt><dd>{taxLabel(line.tax_rate)} · {amount(line.tax_amount)}</dd></div>
        <div><dt>Связанная строка</dt><dd>{line.parent_position ?? 'Не указана'}</dd></div>
        <div><dt>Код магазина</dt><dd>{line.store_item_code ?? missing}</dd></div>
        <div><dt>Штрихкод</dt><dd>{line.barcode ?? missing}</dd></div>
        <div><dt>Код налога</dt><dd>{line.tax_code ?? missing}</dd></div>
        <div><dt>Подакцизный</dt><dd>{yesNo(line.is_excise)}</dd></div>
        <div><dt>Маркированный</dt><dd>{yesNo(line.is_marked)}</dd></div>
      </dl>
    </li>)}</ol>}
    <h4>Скидки ({result.discounts.length})</h4>
    {result.discounts.length === 0 ? <p>Скидки не прочитаны.</p> : <ul>{result.discounts.map((discount, index) => <li key={index}>{discount.name ?? missing}: {amount(discount.amount)} · позиция {discount.position ?? missing} · строка {discount.line_position ?? 'Не указана'}</li>)}</ul>}
    <h4>Налоги ({result.taxes.length})</h4>
    {result.taxes.length === 0 ? <p>Налоговые итоги не прочитаны.</p> : <ul>{result.taxes.map((tax, index) => <li key={index}>{taxLabel(tax.tax_rate)} · код {tax.tax_code ?? missing} · без налога {amount(tax.net)} · налог {amount(tax.tax)} · с налогом {amount(tax.gross)}</li>)}</ul>}
  </details>
}
