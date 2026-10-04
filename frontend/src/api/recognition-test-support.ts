/// <reference types="node" />
import { readFileSync } from 'node:fs'

/** Read the backend's public contract; never maintain a second copy of it. */
export function publicFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../backend/recognition/tests/fixtures/public/${name}`, import.meta.url), 'utf8'))
}
