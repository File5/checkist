import { beforeEach } from 'vitest'
import { forgetAnswers } from './api/answer-cache'
import { releaseWrites } from './api/write-gate'
import { resetMoneyDigits } from './lib/money-digits'

// Every test starts like a fresh page: no API answer is remembered, no write waits for «Я», and money is shown in
// whole units (the default of «Суммы»).
beforeEach(() => {
  forgetAnswers()
  releaseWrites('stop')
  resetMoneyDigits()
})
