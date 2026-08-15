import {
  allocate,
  parseMoneyInput,
  applyBasisPoints,
  assertInteger,
  formatMoney,
  isSupportedCurrency,
  minorUnitFactor,
  roundHalfAwayFromZero,
  sum,
  toMajor,
  toMinor,
} from '../../src/core/money'

describe('currency metadata', () => {
  it('uses the correct ISO 4217 exponent per currency', () => {
    expect(minorUnitFactor('USD')).toBe(100)
    expect(minorUnitFactor('GHS')).toBe(100)
    // Zero-decimal: the minor unit IS the major unit.
    expect(minorUnitFactor('JPY')).toBe(1)
    expect(minorUnitFactor('KRW')).toBe(1)
    // Three-decimal.
    expect(minorUnitFactor('KWD')).toBe(1000)
  })

  it('is case-insensitive and rejects unknown codes', () => {
    expect(isSupportedCurrency('ghs')).toBe(true)
    expect(isSupportedCurrency('XYZ')).toBe(false)
    expect(() => minorUnitFactor('XYZ')).toThrow(/Unsupported currency/)
  })
})

describe('major <-> minor conversion', () => {
  it('round-trips two-decimal currencies', () => {
    expect(toMinor(12.34, 'USD')).toBe(1234)
    expect(toMajor(1234, 'USD')).toBe(12.34)
  })

  it('does not multiply zero-decimal currencies by 100', () => {
    // The bug this guards: ¥5000 becoming ¥500,000 on a Japanese invoice.
    expect(toMinor(5000, 'JPY')).toBe(5000)
    expect(toMajor(5000, 'JPY')).toBe(5000)
  })

  it('handles three-decimal currencies', () => {
    expect(toMinor(1.235, 'KWD')).toBe(1235)
  })

  it('absorbs float representation error where recovery is possible', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754, but the error is small enough that
    // rounding still lands on 30.
    expect(toMinor(0.1 + 0.2, 'USD')).toBe(30)
  })

  it('DOCUMENTS the float precision limit that motivates string input', () => {
    // 1.005 has no exact double. The nearest is 1.00499999999999989...,
    // so 1.005 * 100 === 100.49999999999999 and rounds DOWN to 100.
    // This is unavoidable: the precision is gone at the literal.
    expect(1.005 * 100).toBeLessThan(100.5)
    expect(toMinor(1.005, 'USD')).toBe(100)
    // The string parser is not subject to this and gives the expected answer.
    expect(parseMoneyInput('1.005', 'USD')).toBe(101)
  })

  it('rejects non-finite input', () => {
    expect(() => toMinor(Number.NaN, 'USD')).toThrow(/finite/)
    expect(() => toMinor(Number.POSITIVE_INFINITY, 'USD')).toThrow(/finite/)
  })
})

describe('roundHalfAwayFromZero', () => {
  it('rounds symmetrically across zero', () => {
    // Math.round(-0.5) is -0, which breaks credit notes. This must not.
    expect(roundHalfAwayFromZero(0.5)).toBe(1)
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1)
    expect(roundHalfAwayFromZero(2.5)).toBe(3)
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3)
  })

  it('satisfies round(x) === -round(-x) for arbitrary values', () => {
    for (const v of [0.1, 1.49, 1.5, 1.51, 99.995, 12345.5]) {
      expect(roundHalfAwayFromZero(v)).toBe(-roundHalfAwayFromZero(-v))
    }
  })
})

describe('assertInteger', () => {
  it('rejects fractional and unsafe values', () => {
    expect(() => assertInteger(1.5, 'amount')).toThrow(/must be an integer/)
    expect(() => assertInteger(Number.MAX_SAFE_INTEGER + 2, 'amount')).toThrow(/safe integer/)
    expect(() => assertInteger(0)).not.toThrow()
    expect(() => assertInteger(-500)).not.toThrow()
  })
})

describe('applyBasisPoints', () => {
  it('computes tax rates exactly', () => {
    // GHS 100.00 at Ghana's 15% VAT component.
    expect(applyBasisPoints(10_000, 1500)).toBe(1500)
    // 2.5% NHIL on the same base.
    expect(applyBasisPoints(10_000, 250)).toBe(250)
    // 9.975% QST, the awkward one.
    expect(applyBasisPoints(10_000, 998)).toBe(998)
  })

  it('rounds to whole minor units', () => {
    expect(applyBasisPoints(333, 1500)).toBe(50) // 49.95 -> 50
    expect(applyBasisPoints(1, 1500)).toBe(0) // 0.15 -> 0
  })

  it('rejects fractional basis points', () => {
    expect(() => applyBasisPoints(10_000, 15.5)).toThrow(/integer/)
  })
})

describe('allocate', () => {
  it('never loses or invents money', () => {
    // The canonical case: 3 equal shares of 10 cents. Naive rounding gives
    // 3+3+3=9 (a cent vanishes) or 4+4+4=12 (a cent appears).
    const parts = allocate(10, [1, 1, 1])
    expect(sum(parts)).toBe(10)
    expect(parts).toEqual([4, 3, 3])
  })

  it('holds the sum invariant across many random cases', () => {
    for (let i = 0; i < 500; i += 1) {
      const total = Math.floor(Math.random() * 1_000_000)
      const n = 1 + Math.floor(Math.random() * 8)
      const weights = Array.from({ length: n }, () => Math.floor(Math.random() * 1000))
      expect(sum(allocate(total, weights))).toBe(total)
    }
  })

  it('allocates proportionally to weights', () => {
    expect(allocate(10_000, [3, 1])).toEqual([7500, 2500])
  })

  it('handles negative totals for credit notes', () => {
    const parts = allocate(-10, [1, 1, 1])
    expect(sum(parts)).toBe(-10)
  })

  it('handles degenerate inputs', () => {
    expect(allocate(100, [])).toEqual([])
    // All-zero weights must still preserve the total.
    expect(sum(allocate(100, [0, 0, 0]))).toBe(100)
  })

  it('rejects negative weights', () => {
    expect(() => allocate(100, [1, -1])).toThrow(/non-negative/)
  })

  it('is deterministic for identical input', () => {
    expect(allocate(101, [1, 1, 1])).toEqual(allocate(101, [1, 1, 1]))
  })
})

describe('parseMoneyInput, exact decimal parsing', () => {
  it('parses plain decimals', () => {
    expect(parseMoneyInput('12.34', 'USD')).toBe(1234)
    expect(parseMoneyInput('0.05', 'USD')).toBe(5)
    expect(parseMoneyInput('1000', 'USD')).toBe(100_000)
  })

  it('respects the currency exponent', () => {
    expect(parseMoneyInput('5000', 'JPY')).toBe(5000)
    expect(parseMoneyInput('1.235', 'KWD')).toBe(1235)
  })

  it('rounds half-up on the first discarded digit', () => {
    expect(parseMoneyInput('1.005', 'USD')).toBe(101)
    expect(parseMoneyInput('1.004', 'USD')).toBe(100)
    expect(parseMoneyInput('1.999', 'USD')).toBe(200)
  })

  it('truncates excess precision rather than throwing', () => {
    expect(parseMoneyInput('12.3456789', 'USD')).toBe(1235)
  })

  it('tolerates thousands separators and whitespace', () => {
    expect(parseMoneyInput(' 1,234.56 ', 'USD')).toBe(123_456)
  })

  it('handles negatives and shorthand forms', () => {
    expect(parseMoneyInput('-12.34', 'USD')).toBe(-1234)
    expect(parseMoneyInput('.5', 'USD')).toBe(50)
    expect(parseMoneyInput('7.', 'USD')).toBe(700)
  })

  it('rejects malformed input', () => {
    for (const bad of ['abc', '', '-', '1.2.3', '12abc', '$5']) {
      expect(() => parseMoneyInput(bad, 'USD')).toThrow()
    }
  })
})

describe('formatMoney', () => {
  it('renders the right number of decimals per currency', () => {
    expect(formatMoney(123_456, 'USD')).toContain('1,234.56')
    // JPY must not show decimals.
    expect(formatMoney(5000, 'JPY')).not.toContain('.')
  })
})
