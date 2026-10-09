import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Card, CardList } from './index'
import type { CardFact } from './index'

const facts: CardFact[] = [
  { key: 'date', label: 'Дата', value: <time dateTime="2026-09-30">30.09.2026</time> },
  { key: 'price', label: 'Цена', value: '189 490,00 KZT/шт', kind: 'value' },
  { key: 'note', label: 'Пояснение', value: 'Свободный текст', kind: 'text' },
  { key: 'names', label: 'Написания', value: <ul><li>Молоко</li></ul>, kind: 'block' },
]

describe('card list markup', () => {
  it('wraps the cards into a labelled list with the caption of the table above it', () => {
    const html = renderToStaticMarkup(
      <CardList label="История цен" caption="Цены по магазинам"><Card title="Магазин" facts={facts} /></CardList>,
    )
    expect(html.startsWith('<div class="ck-cards"><p class="ck-cards-caption">Цены по магазинам</p><ul class="ck-cards-list" aria-label="История цен"><li class="ck-card">')).toBe(true)
    expect(html.endsWith('</li></ul></div>')).toBe(true)
  })

  it('names the list by an existing heading and omits an absent caption', () => {
    const html = renderToStaticMarkup(<CardList labelledBy="lines-title"><Card title="Строка" facts={[]} /></CardList>)
    expect(html).toBe('<div class="ck-cards"><ul class="ck-cards-list" aria-labelledby="lines-title"><li class="ck-card"><div class="ck-card-title">Строка</div></li></ul></div>')
    expect(html).not.toContain('aria-label=')
    for (const caption of [null, undefined, false, '']) {
      expect(renderToStaticMarkup(<CardList label="Список" caption={caption}>{null}</CardList>)).toBe('<div class="ck-cards"><ul class="ck-cards-list" aria-label="Список"></ul></div>')
    }
  })
})

describe('card markup', () => {
  it('renders the title, the facts in the given order and the footer', () => {
    const html = renderToStaticMarkup(<Card title={<a href="/catalog/products/7">Молоко</a>} facts={facts} footer={<button type="button">Исключить из группы</button>} />)
    expect(html).toBe(
      '<li class="ck-card">'
      + '<div class="ck-card-title"><a href="/catalog/products/7">Молоко</a></div>'
      + '<dl class="ck-card-facts">'
      + '<div class="ck-card-fact" data-kind="value"><dt>Дата</dt><dd><time dateTime="2026-09-30">30.09.2026</time></dd></div>'
      + '<div class="ck-card-fact" data-kind="value"><dt>Цена</dt><dd>189 490,00 KZT/шт</dd></div>'
      + '<div class="ck-card-fact" data-kind="text"><dt>Пояснение</dt><dd>Свободный текст</dd></div>'
      + '<div class="ck-card-fact" data-kind="block"><dt>Написания</dt><dd><ul><li>Молоко</li></ul></dd></div>'
      + '</dl>'
      + '<div class="ck-card-footer"><button type="button">Исключить из группы</button></div>'
      + '</li>',
    )
  })

  it('takes the focus from a script only when it is a link target', () => {
    const target = renderToStaticMarkup(<Card id="receipt-line-3" title="Строка 3" facts={[]} />)
    expect(target).toContain('<li class="ck-card" id="receipt-line-3" tabindex="-1">')
    const plain = renderToStaticMarkup(<Card title="Строка 3" facts={[]} />)
    expect(plain).not.toContain('tabindex')
    expect(plain).not.toContain(' id=')
  })

  it('does not render an empty fact, keeps a zero', () => {
    const html = renderToStaticMarkup(
      <Card
        title="Запись"
        facts={[
          { key: 'a', label: 'Оставляемая запись', value: null },
          { key: 'b', label: 'Действие', value: undefined },
          { key: 'c', label: 'Скидка', value: false },
          { key: 'd', label: 'Магазин', value: '' },
          { key: 'e', label: 'Количество', value: 0 },
          { key: 'f', label: 'Сумма', value: '0,00 RUB' },
        ]}
      />,
    )
    expect([...html.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)].map((match) => [match[1], match[2]])).toEqual([['Количество', '0'], ['Сумма', '0,00 RUB']])
    expect(html.match(/class="ck-card-fact"/g)).toHaveLength(2)
  })

  it('omits the list of facts and the footer when there is nothing to show', () => {
    const html = renderToStaticMarkup(<Card title="Запись" facts={[{ key: 'a', label: 'Действие', value: null }]} footer={false} />)
    expect(html).toBe('<li class="ck-card"><div class="ck-card-title">Запись</div></li>')
  })

  it('marks the total card', () => {
    const html = renderToStaticMarkup(<Card title="Итого" tone="total" facts={[{ key: 'sum', label: 'Изменение', value: '+120,00 RUB' }]} />)
    expect(html).toContain('<li class="ck-card" data-tone="total">')
    expect(renderToStaticMarkup(<Card title="Строка" facts={[]} />)).not.toContain('data-tone')
  })
})
