import { describe, expect, it } from 'vitest'
import { chipScrollLeft } from './chip-in-view'

describe('the chosen chip in sight (pure arithmetic, not scrolling)', () => {
  it('leaves the row alone while the chip is whole in sight', () => {
    expect(chipScrollLeft(0, 240, 10, 100)).toBe(0)
    expect(chipScrollLeft(50, 240, 60, 120)).toBe(50)
  })
  it('brings a chip behind the end to the start of the row, with a little of the previous one showing', () => {
    // «Всё время» at the end of five chips is the default period.
    expect(chipScrollLeft(0, 240, 420, 110)).toBe(396)
    expect(chipScrollLeft(0, 240, 200, 110, 16)).toBe(184)
  })
  it('brings a chip cut at the start back, never before the start of the row', () => {
    expect(chipScrollLeft(300, 240, 120, 100)).toBe(96)
    expect(chipScrollLeft(300, 240, 10, 100)).toBe(0)
  })
})
