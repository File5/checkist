/** The words of the button that opens the filters on a phone: the number only when something is filtered. */
export function filtersButtonLabel(count: number, title = 'Фильтры') {
  return count > 0 ? `${title} (${count})` : title
}
