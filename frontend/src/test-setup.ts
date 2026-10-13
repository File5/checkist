import { beforeEach } from 'vitest'
import { forgetAnswers } from './api/answer-cache'
import { releaseWrites } from './api/write-gate'

// Every test starts like a fresh page: no API answer is remembered and no write waits for «Я».
beforeEach(() => {
  forgetAnswers()
  releaseWrites('stop')
})
