import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MergeGroup, MergeLine } from '../../api/product-merges'
import { isMergeLine } from '../../api/product-merges-schema'
import { mergeFixture } from '../../api/product-merges-test-support'
import { page } from '../../api/schema'
import type { Page } from '../../api/types'
import type { ActionState } from './actions'
import MergeGroupView from './MergeGroupView'
import MergeLines from './MergeLines'
import { initialSelection, selectTarget } from './state'
import type { MergeSelection } from './state'
import { group, lines } from './test-support'

/** The only thing replaced is the width of the screen: the components, the cards and the fixtures are real. */
const screen = vi.hoisted(() => ({ narrow: false }))
vi.mock('../../lib/cards', async (original) => ({ ...await original<typeof import('../../lib/cards')>(), useNarrow: () => screen.narrow }))
beforeEach(() => { screen.narrow = false })

const noop = () => {}
const idle: ActionState = { kind: 'idle' }
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const pizza = group('group-pending.json')
const milk = group('group-pending-conflict.json')
const confirmed = group('group-confirmed.json')
const cancelled = group('group-cancelled.json')
const excluded: MergeGroup = { ...pizza, version: 2, members: pizza.members.map((member) => member.product_id === 43
  ? { ...member, state: 'excluded' as const, lines_count: 0, first_purchased_on: null, last_purchased_on: null, aliases: [] } : member) }
const foreignLines = (): Page<MergeLine> => {
  const body = mergeFixture('lines_foreign.json')
  if (!page(isMergeLine)(body)) throw new Error('Invalid fixture lines_foreign.json')
  return body
}

function members(data: MergeGroup, narrow: boolean, selection: MergeSelection = initialSelection(data), action: ActionState = idle): string {
  screen.narrow = narrow
  return renderToStaticMarkup(<MergeGroupView group={data} selection={selection} action={action} onSelection={noop} onConfirm={noop} onCancel={noop} onExclude={noop} />)
}
function purchases(data: Page<MergeLine>, narrow: boolean): string {
  screen.narrow = narrow
  return renderToStaticMarkup(<MergeLines group={pizza} lines={data} onPage={noop} />)
}

interface Row { title: string; facts: [label: string, value: string][] }

/** Rows of a table as the cards must repeat them: the row heading, then «column heading — cell» without empty cells. */
function tableRows(html: string): Row[] {
  const [head, body] = html.slice(html.indexOf('<thead>'), html.indexOf('</tbody>')).split('<tbody>')
  const headings = [...head.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => match[1])
  return body.split('<tr>').slice(1).map((row) => {
    const cells = [...row.matchAll(/<(th scope="row"|td)[^>]*>(.*?)<\/(?:th|td)>/g)]
    expect(cells).toHaveLength(headings.length)
    const heading = cells.findIndex((cell) => cell[1] !== 'td')
    return {
      title: cells[heading][2],
      facts: cells.flatMap((cell, index): [string, string][] => index === heading || cell[2] === '' ? [] : [[headings[index], cell[2]]]),
    }
  })
}

function cardRows(html: string): Row[] {
  return html.split('<li class="ck-card">').slice(1).map((card) => ({
    title: card.slice('<div class="ck-card-title">'.length, card.indexOf('</div>')),
    facts: card.split('<div class="ck-card-fact" data-kind="').slice(1).map((fact): [string, string] =>
      [fact.match(/<dt>(.*?)<\/dt>/)?.[1] ?? '', fact.slice(fact.indexOf('<dd>') + 4, fact.lastIndexOf('</dd></div>'))]),
  }))
}
const kinds = (html: string) => [...html.matchAll(/<div class="ck-card-fact" data-kind="(\w+)"><dt>(.*?)<\/dt>/g)].map((match) => `${match[2]}: ${match[1]}`)
const labels = (rows: Row[]) => rows.map((row) => row.facts.map(([label]) => label))

describe('records of a group as cards (SSR in Node, backend fixtures)', () => {
  it.each([
    ['pending', pizza], ['pending with a conflict', milk], ['confirmed', confirmed], ['cancelled', cancelled], ['with an excluded record', excluded],
  ])('repeats every row of the table of a %s group: heading, column headings and cells', (_name, data) => {
    const table = tableRows(members(data, false))
    const cards = cardRows(members(data, true))
    expect(table).toHaveLength(data.members.length)
    expect(cards).toEqual(table)
  })

  it('repeats the table while a record is being excluded and with another kept record', () => {
    const excluding: ActionState = { kind: 'pending', action: { type: 'exclude', id: 2, input: { version: 1, product_id: 43 } } }
    expect(cardRows(members(pizza, true, initialSelection(pizza), excluding))).toEqual(tableRows(members(pizza, false, initialSelection(pizza), excluding)))
    const other = selectTarget(initialSelection(pizza), 43)
    expect(cardRows(members(pizza, true, other))).toEqual(tableRows(members(pizza, false, other)))
  })

  it('names the facts of a pending group by the column headings in the order of the columns', () => {
    const html = members(pizza, true)
    expect(labels(cardRows(html))).toEqual(Array(3).fill(['Оставляемая запись', 'Написания в чеках', 'Покупок', 'Даты покупок', 'Факты', 'Действие']))
    expect(kinds(html).slice(0, 6)).toEqual(['Оставляемая запись: value', 'Написания в чеках: block', 'Покупок: value', 'Даты покупок: value', 'Факты: block', 'Действие: value'])
    expect(html).toContain('<p class="ck-cards-caption">Выберите запись, которая останется товаром каталога.')
    expect(html).toContain('<ul class="ck-cards-list" aria-labelledby="merge-members-title">')
    expect(html).toContain('<h2 id="merge-members-title">Записи группы</h2>')
  })

  it('keeps the radio «Оставить» with the same name, value and hidden text and the button with its label', () => {
    const html = members(pizza, true)
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((match) => match[0])
    for (const radio of radios) expect(radio).toContain(' name="merge-target"')
    expect(radios).toHaveLength(3)
    expect(radios.filter((radio) => radio.includes('checked=""')).map((radio) => radio.match(/value="(\d+)"/)?.[1])).toEqual(['5'])
    expect(html).toContain('<label class="ck-merge-choice"><input type="radio" name="merge-target"')
    expect(html).toContain('<span>Оставить<span class="ck-merge-hidden"> запись №43: Steinof.PizzaSpezial</span></span>')
    expect(html.match(/<button type="button" class="ck-merge-secondary" aria-label="Исключить из группы запись №\d+: [^"]+">Исключить из группы<\/button>/g)).toHaveLength(3)
    expect(html).toContain('aria-label="Исключить из группы запись №43: Steinof.PizzaSpezial"')
    const chosen = members(pizza, true, selectTarget(initialSelection(pizza), 43))
    expect(chosen.match(/<input type="radio"[^>]*checked=""[^>]*>/g)).toEqual(['<input type="radio" name="merge-target" checked="" value="43"/>'])
  })

  it('disables the controls of the cards while a request is running and names the running exclusion', () => {
    const html = members(pizza, true, initialSelection(pizza), { kind: 'pending', action: { type: 'exclude', id: 2, input: { version: 1, product_id: 43 } } })
    expect(html.match(/<input type="radio"[^>]*>/g)).toHaveLength(3)
    expect(html.match(/<input type="radio"[^>]*disabled=""/g)).toHaveLength(3)
    expect(html.match(/>Исключаем…<\/button>/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="Исключить из группы запись №43: Steinof.PizzaSpezial"[^>]*>Исключаем…/)
    expect(html.match(/<button[^>]*disabled=""[^>]*>Исключить из группы<\/button>/g)).toHaveLength(2)
  })

  it('puts every date into <time> and never starts a line with the dash of a period', () => {
    const html = members(pizza, true)
    expect(html).toContain('<dt>Даты покупок</dt><dd><time dateTime="2026-06-09">09.06.2026</time>\u00a0— <time dateTime="2026-07-06">06.07.2026</time></dd>')
    expect(html).toContain('<dt>Даты покупок</dt><dd><time dateTime="2026-06-29">29.06.2026</time></dd>')
    for (const value of cardRows(html).flatMap((row) => row.facts).filter(([label]) => label === 'Даты покупок').map(([, text]) => text)) {
      expect(value.replace(/<time dateTime="\d{4}-\d{2}-\d{2}">\d{2}\.\d{2}\.\d{4}<\/time>/g, '')).not.toMatch(/\d/)
    }
  })

  it('links only the record which is still a catalog product and marks the others in the heading', () => {
    const html = members(pizza, true)
    expect(html).toContain('<div class="ck-card-title"><a href="/catalog/products/5">Steinhof.PizzaSpezial</a><span class="ck-merge-subtext">Запись\u00a0№5 · оставляемая по умолчанию</span></div>')
    expect(html).not.toContain('href="/catalog/products/26"')
    expect(html).not.toContain('href="/catalog/products/43"')
    const done = members(confirmed, true)
    expect(done).toContain('href="/catalog/products/2"'); expect(done).not.toContain('href="/catalog/products/14"')
    expect(done).toMatch(/<div class="ck-card-title">[^<]*<span class="ck-merge-subtext">Запись\u00a0№14 · удалена после слияния<\/span><\/div>/)
    expect(done).toContain(' · оставленный товар</span></div>')
  })

  it.each([['confirmed', confirmed], ['cancelled', cancelled]])('shows a %s group without the facts «Оставляемая запись» and «Действие» and without controls', (_name, data) => {
    const html = members(data, true)
    expect(labels(cardRows(html))).toEqual(Array(data.members.length).fill(['Написания в чеках', 'Покупок', 'Даты покупок', 'Факты']))
    expect(html).not.toContain('Оставляемая запись'); expect(html).not.toContain('<dt>Действие</dt>')
    expect(html).not.toContain('<input'); expect(html).not.toContain('<button'); expect(html).not.toContain('ck-card-footer')
    expect(html).toContain('<p class="ck-cards-caption">Записи группы на момент завершения.</p>')
    expect(html).toContain('действия с группой больше недоступны')
  })

  it('marks an excluded record in the heading and leaves it without a choice, an action and empty facts', () => {
    const html = members(excluded, true)
    const card = cardRows(html)[excluded.members.findIndex((member) => member.product_id === 43)]
    expect(card.title).toBe('<a href="/catalog/products/43">Steinof.PizzaSpezial</a><span class="ck-merge-subtext">Запись\u00a0№43 · исключена из группы</span>')
    expect(card.facts.map(([label]) => label)).toEqual(['Написания в чеках', 'Покупок', 'Даты покупок', 'Факты'])
    expect(Object.fromEntries(card.facts)).toMatchObject({ 'Написания в чеках': '—', 'Покупок': '0', 'Даты покупок': 'Нет покупок' })
    expect(html.match(/name="merge-target"/g)).toHaveLength(2)
    expect(html.match(/>Исключить из группы<\/button>/g)).toHaveLength(2)
    expect(html).not.toContain('<dd></dd>')
  })

  it('renders one view only: cards replace the table, the rest of the form stays as it was', () => {
    const wide = members(milk, false)
    const narrow = members(milk, true)
    expect(wide).toContain('<table'); expect(wide).not.toContain('ck-card')
    expect(narrow).not.toContain('<table'); expect(narrow).not.toContain('ck-merge-table-scroll'); expect(narrow).not.toContain('<caption')
    expect(narrow.match(/name="merge-target"/g)).toHaveLength(milk.members.length)
    for (const html of [wide, narrow]) {
      expect(html.match(/ id="merge-members-title"/g)).toHaveLength(1)
      expect(html.match(/<select id="merge-name"/g)).toHaveLength(1)
      expect(html.match(/name="merge-resolution-generic"/g)).toHaveLength(2)
      expect(html).toContain('<legend>Обобщённый продукт</legend>')
      expect(html).toContain('>Подтвердить слияние</button>'); expect(html).toContain('>Отменить слияние</button>')
      expect(html).toContain('role="status" aria-live="polite"')
    }
    const rest = (html: string) => html.slice(html.indexOf('<div class="ck-merge-field">'))
    expect(rest(narrow)).toBe(rest(wide))
    expect(narrow.indexOf('ck-cards')).toBeLessThan(narrow.indexOf('<div class="ck-merge-field">'))
  })

  it('does not pin the irreversible actions: the block of «Подтвердить слияние» is not an action bar', () => {
    expect(members(pizza, true)).toContain('<div class="ck-merge-actions"><button type="submit"')
    for (const name of ['MergeGroupView.tsx', 'MergeMemberCards.tsx', 'MergeLines.tsx', 'MergeLineCards.tsx']) expect(source(name)).not.toContain('ck-action-bar')
  })
})

describe('purchases of a group as cards (SSR in Node, backend fixtures)', () => {
  it.each([['own', lines], ['own and foreign', foreignLines]])('repeats every row of the table of %s purchases: printed name, column headings and cells', (_name, data) => {
    const table = tableRows(purchases(data(), false))
    const cards = cardRows(purchases(data(), true))
    expect(table).toHaveLength(data().results.length)
    expect(cards).toEqual(table)
  })

  it('names the facts by the column headings in the order of the columns and titles the card by the printed name', () => {
    const html = purchases(lines(), true)
    const cards = cardRows(html)
    expect(labels(cards)).toEqual(Array(5).fill(['Исходная запись', 'Дата', 'Магазин', 'Количество', 'Цена', 'Сумма', 'Чек']))
    expect(cards.map((card) => card.title)).toEqual(lines().results.map((line) => line.name))
    expect(kinds(html).slice(0, 7)).toEqual(['Исходная запись: text', 'Дата: value', 'Магазин: text', 'Количество: value', 'Цена: value', 'Сумма: value', 'Чек: value'])
    expect(html).toContain('<p class="ck-cards-caption">5\u00a0покупок · страница 1 из 1. Название — как напечатано в чеке.</p>')
    expect(html).toContain('<ul class="ck-cards-list" aria-label="Покупки группы">')
  })

  it('shows the original record, the date in <time>, money as strings and the receipt link', () => {
    const html = purchases(lines(), true)
    expect(html).toContain('<div class="ck-card-title">Steinof.PizzaSpezial</div>')
    expect(html).toContain('<dt>Исходная запись</dt><dd>№43: Steinof.PizzaSpezial</dd>')
    expect(html).toContain('<dt>Исходная запись</dt><dd>Добавлена после слияния</dd>')
    expect(html).toContain('<dt>Дата</dt><dd><time dateTime="2026-10-01">01.10.2026</time></dd>')
    expect(html.match(/<dt>Дата<\/dt><dd><time dateTime="\d{4}-\d{2}-\d{2}">\d{2}\.\d{2}\.\d{4}<\/time><\/dd>/g)).toHaveLength(5)
    expect(html).toContain('<dt>Сумма</dt><dd>3,49\u00a0EUR</dd>'); expect(html).toContain('<dt>Сумма</dt><dd>3,59\u00a0EUR</dd>')
    expect(html).toContain('<dt>Количество</dt><dd>1\u00a0шт</dd>'); expect(html).toMatch(/<dt>Цена<\/dt><dd>3,49\u00a0EUR[^<]*<\/dd>/)
    expect(html).toContain('Musterstadt · DE')
    expect(html).toMatch(/<dt>Чек<\/dt><dd><a href="\/receipts\/13">Чек\u00a0№13<\/a><span class="ck-merge-subtext">позиция\u00a0\d+<\/span><\/dd>/)
  })

  it('shows «Чужая покупка» without a link and a position, with the quantity and the money of such a line', () => {
    const html = purchases(foreignLines(), true)
    expect(html).toContain('<p class="ck-cards-caption">4\u00a0покупки · страница 1 из 1.')
    const cards = html.split('<li class="ck-card">').slice(1)
    expect(cards).toHaveLength(4)
    const foreign = cards.filter((card) => card.includes('<dt>Чек</dt><dd>Чужая покупка</dd>'))
    expect(foreign).toHaveLength(2)
    expect(foreign[0]).toContain('<div class="ck-card-title">Steinhof.PizzaSpezial</div>')
    expect(foreign[1]).toContain('<dt>Исходная запись</dt><dd>№26: Steinhof PizzaSpezial</dd>')
    for (const card of foreign) {
      expect(card).not.toContain('<a '); expect(card).not.toContain('Чек\u00a0№'); expect(card).not.toContain('позиция')
      expect(card).toContain('Demomarkt'); expect(card).toContain('<time dateTime=')
      expect(card).toMatch(/<dt>Количество<\/dt><dd>[^<]*шт<\/dd>/)
      expect(card).toMatch(/<dt>Цена<\/dt><dd>[^<]*3,49[^<]*EUR[^<]*<\/dd>/)
      expect(card).toMatch(/<dt>Сумма<\/dt><dd>[^<]*3,49[^<]*EUR<\/dd>/)
    }
    const mine = cards.filter((card) => !card.includes('Чужая покупка'))
    expect(mine[0]).toContain('href="/receipts/9">Чек\u00a0№9</a><span class="ck-merge-subtext">позиция\u00a01</span>')
    expect(mine[1]).toContain('href="/receipts/11">Чек\u00a0№11</a>')
    expect(html).not.toContain('null')
  })

  it('renders one view only and keeps the pagination under the cards', () => {
    const data = { ...lines(), count: 120, pages: 3, page: 2 }
    const wide = purchases(data, false)
    const narrow = purchases(data, true)
    expect(wide).toContain('<table'); expect(wide).not.toContain('ck-card')
    expect(narrow).not.toContain('<table'); expect(narrow).not.toContain('ck-merge-table-scroll')
    expect(narrow).toContain('120\u00a0покупок · страница 2 из 3.')
    const pagination = (html: string) => html.slice(html.indexOf('<nav'))
    expect(pagination(narrow)).toContain('aria-label="Страницы покупок группы"')
    expect(pagination(narrow)).toBe(pagination(wide))
    expect(narrow.indexOf('ck-cards')).toBeLessThan(narrow.indexOf('<nav'))
  })

  it('leaves the empty state as it was on a phone', () => {
    const empty = { ...lines(), count: 0, pages: 0, results: [] }
    screen.narrow = true
    const narrow = renderToStaticMarkup(<MergeLines group={cancelled} lines={empty} onPage={noop} />)
    screen.narrow = false
    expect(narrow).toBe(renderToStaticMarkup(<MergeLines group={cancelled} lines={empty} onPage={noop} />))
    expect(narrow).toContain('покупки возвращены исходным товарам')
    expect(narrow).not.toContain('ck-card')
  })
})

describe('sources of the two views (text, not rendering)', () => {
  it('takes the column headings from one object for the table and the cards', () => {
    for (const [file, heading] of [['MergeGroupView.tsx', 'Оставляемая запись'], ['MergeLines.tsx', 'Напечатанное название']] as const) {
      const text = source(file)
      expect(text.split(`'${heading}'`)).toHaveLength(2)
      expect(text).toMatch(/\bconst narrow = useNarrow\(\)/)
      expect(text).toMatch(/<th scope="col"[^>]*>\{columns\.\w+\}<\/th>/)
      expect(text).not.toMatch(/<th scope="col"[^>]*>[^{<]/)
    }
    for (const file of ['MergeMemberCards.tsx', 'MergeLineCards.tsx']) {
      const text = source(file)
      expect(text).not.toMatch(/label: '/)
      expect(text).not.toMatch(/toFixed|Intl\.|toLocaleDateString|<style|style=/)
    }
  })
})
