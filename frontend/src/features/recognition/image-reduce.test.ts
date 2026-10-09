import { describe, expect, it, vi } from 'vitest'
import { REDUCED_LONG_SIDE, reduceImage, reducedName, reducedSize, reductionPlan } from './image-reduce'
import type { ReduceEnvironment } from './image-reduce'

const limits = { max_bytes: 20_971_520, max_pixels: 40_000_000 }

describe('reductionPlan: the photo is touched only over a limit', () => {
  it('keeps a photo exactly at both limits and reduces one byte or one pixel over', () => {
    // 8000 × 5000 is exactly 40 000 000 pixels.
    expect(reductionPlan({ width: 8000, height: 5000, bytes: limits.max_bytes }, limits)).toEqual({ kind: 'keep' })
    expect(reductionPlan({ width: 8000, height: 5000, bytes: limits.max_bytes + 1 }, limits)).toEqual({ kind: 'reduce', bytes: true, pixels: false, width: 4096, height: 2560 })
    expect(reductionPlan({ width: 8001, height: 5000, bytes: limits.max_bytes }, limits)).toMatchObject({ kind: 'reduce', bytes: false, pixels: true, width: 4096 })
    expect(reductionPlan({ width: 8000, height: 5001, bytes: 1 }, limits)).toMatchObject({ kind: 'reduce', bytes: false, pixels: true })
    expect(reductionPlan({ width: 12000, height: 9000, bytes: limits.max_bytes + 1 }, limits)).toEqual({ kind: 'reduce', bytes: true, pixels: true, width: 4096, height: 3072 })
  })
  it('keeps a small or an ordinary phone photo as it is', () => {
    for (const photo of [{ width: 1, height: 1, bytes: 1 }, { width: 4032, height: 3024, bytes: 5_557_453 }, { width: 3024, height: 4032, bytes: 5_557_453 }, { width: 6000, height: 4000, bytes: 12_000_000 }]) {
      expect(reductionPlan(photo, limits), JSON.stringify(photo)).toEqual({ kind: 'keep' })
    }
  })
  it('brings the long side to 4096 px in either orientation and keeps the proportions', () => {
    expect(REDUCED_LONG_SIDE).toBe(4096)
    expect(reductionPlan({ width: 16320, height: 12240, bytes: 1 }, limits)).toMatchObject({ width: 4096, height: 3072 })
    expect(reductionPlan({ width: 12240, height: 16320, bytes: 1 }, limits)).toMatchObject({ width: 3072, height: 4096 })
    // A long receipt: the short side never becomes zero.
    expect(reductionPlan({ width: 10, height: 5_000_000, bytes: 1 }, limits)).toMatchObject({ width: 1, height: 4096 })
  })
  it('never enlarges: a heavy photo within 4096 px is encoded again at its own size', () => {
    expect(reductionPlan({ width: 4000, height: 3000, bytes: limits.max_bytes + 1 }, limits)).toEqual({ kind: 'reduce', bytes: true, pixels: false, width: 4000, height: 3000 })
    expect(reducedSize({ width: 4096, height: 4096 }, limits)).toEqual({ width: 4096, height: 4096 })
  })
  it('also fits the area limit of a server with a small one', () => {
    const size = reducedSize({ width: 8000, height: 6000 }, { max_pixels: 1_000_000 })
    expect(size.width * size.height).toBeLessThanOrEqual(1_000_000)
    expect(size.width / size.height).toBeCloseTo(8000 / 6000, 2)
    expect(reductionPlan({ width: 2000, height: 1000, bytes: 1 }, { max_bytes: 10, max_pixels: 1_000_000 })).toMatchObject({ kind: 'reduce', pixels: true, bytes: false })
  })
  it('decides by the bytes alone while the pixel size is unknown', () => {
    for (const size of [{}, { width: 0, height: 0 }, { width: Number.NaN, height: 100 }, { width: 100 }]) {
      expect(reductionPlan({ ...size, bytes: limits.max_bytes }, limits)).toEqual({ kind: 'keep' })
      expect(reductionPlan({ ...size, bytes: limits.max_bytes + 1 }, limits)).toEqual({ kind: 'reduce', bytes: true, pixels: false })
    }
  })
})

describe('reduceImage with a stand-in for the browser', () => {
  const source = () => new File([new Uint8Array(64)], 'IMG 0001.PNG', { type: 'image/png', lastModified: 1_700_000_000_000 })
  const environment = (size = { width: 12000, height: 9000 }, blob: Blob | null = new Blob([new Uint8Array(32)], { type: 'image/jpeg' })) => {
    const close = vi.fn()
    const picture = { ...size, source: { bitmap: true }, close }
    return { close, decode: vi.fn(async () => picture), encode: vi.fn(async () => blob) } satisfies ReduceEnvironment & { close: unknown }
  }

  it('draws the decoded photo at the planned size and names the copy as a JPEG of the same time', async () => {
    const browser = environment()
    const file = source()
    const reduced = await reduceImage(file, limits, undefined, browser)
    expect(browser.decode).toHaveBeenCalledExactlyOnceWith(file)
    expect(browser.encode).toHaveBeenCalledExactlyOnceWith({ bitmap: true }, { width: 4096, height: 3072 })
    expect(reduced).toMatchObject({ width: 4096, height: 3072 })
    expect(reduced.file).toMatchObject({ name: 'IMG 0001.jpg', type: 'image/jpeg', size: 32, lastModified: 1_700_000_000_000 })
    expect(browser.close).toHaveBeenCalledTimes(1)
  })
  it('follows the real size of the decoded photo, with the EXIF turn applied', async () => {
    const browser = environment({ width: 9000, height: 12000 })
    expect(await reduceImage(source(), limits, undefined, browser)).toMatchObject({ width: 3072, height: 4096 })
  })
  it.each([
    ['no blob', null], ['an empty blob', new Blob([], { type: 'image/jpeg' })],
    ['another format instead of JPEG', new Blob([new Uint8Array(8)], { type: 'image/png' })],
    ['a copy still over the byte limit', new Blob([new Uint8Array(11)], { type: 'image/jpeg' })],
  ])('rejects on %s and releases the picture', async (_name, blob) => {
    const browser = environment(undefined, blob)
    await expect(reduceImage(source(), { ...limits, max_bytes: 10 }, undefined, browser)).rejects.toThrow()
    expect(browser.close).toHaveBeenCalledTimes(1)
  })
  it('rejects when the browser cannot decode or draw, and after a stop', async () => {
    const broken = { decode: vi.fn(async () => { throw new Error('memory') }), encode: vi.fn() }
    await expect(reduceImage(source(), limits, undefined, broken)).rejects.toThrow('memory')
    expect(broken.encode).not.toHaveBeenCalled()
    const failing = environment(); failing.encode.mockRejectedValue(new Error('canvas'))
    await expect(reduceImage(source(), limits, undefined, failing)).rejects.toThrow('canvas')
    expect(failing.close).toHaveBeenCalledTimes(1)

    const stopped = new AbortController(); stopped.abort()
    const early = environment()
    await expect(reduceImage(source(), limits, stopped.signal, early)).rejects.toThrow()
    expect(early.encode).not.toHaveBeenCalled(); expect(early.close).toHaveBeenCalledTimes(1)
    const late = new AbortController()
    const browser = environment(); browser.encode.mockImplementation(async () => { late.abort(); return new Blob([new Uint8Array(4)], { type: 'image/jpeg' }) })
    await expect(reduceImage(source(), limits, late.signal, browser)).rejects.toThrow()
  })
  it('names the copy after the photo', () => {
    expect(reducedName('чек.jpeg')).toBe('чек.jpg'); expect(reducedName('a.b.webp')).toBe('a.b.jpg')
    expect(reducedName('image')).toBe('image.jpg'); expect(reducedName('.hidden')).toBe('.hidden.jpg'); expect(reducedName('')).toBe('photo.jpg')
  })
})
