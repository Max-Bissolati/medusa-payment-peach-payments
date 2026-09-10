import { BigNumber } from "@medusajs/framework/utils"
import { amountsMatch, formatPeachAmount } from "../lib/amount"

describe("formatPeachAmount (major unit, 2dp: no ×100)", () => {
  it("formats whole numbers with two decimals", () => {
    expect(formatPeachAmount(15000)).toBe("15000.00")
    expect(formatPeachAmount(0)).toBe("0.00")
    expect(formatPeachAmount(1)).toBe("1.00")
  })

  it("preserves cents", () => {
    expect(formatPeachAmount(15000.5)).toBe("15000.50")
    expect(formatPeachAmount(99.99)).toBe("99.99")
  })

  it("accepts string and BigNumber inputs", () => {
    expect(formatPeachAmount("15000")).toBe("15000.00")
    expect(formatPeachAmount("2500.40")).toBe("2500.40")
    expect(formatPeachAmount(new BigNumber(15000))).toBe("15000.00")
    expect(formatPeachAmount(new BigNumber("1250.25"))).toBe("1250.25")
  })

  it("rounds to cents defensively", () => {
    expect(formatPeachAmount(1234.567)).toBe("1234.57")
    expect(formatPeachAmount(1234.561)).toBe("1234.56")
  })

  it("does NOT multiply by 100 (the classic Peach mistake)", () => {
    expect(formatPeachAmount(15000)).not.toBe("1500000.00")
  })

  it("throws on negative or non-finite amounts", () => {
    expect(() => formatPeachAmount(-1)).toThrow()
    expect(() => formatPeachAmount(Number.NaN)).toThrow()
    expect(() => formatPeachAmount(Number.POSITIVE_INFINITY)).toThrow()
  })
})

describe("amountsMatch (amount-integrity comparison: fails CLOSED)", () => {
  it("is true for equal amounts across string/number and formatting", () => {
    expect(amountsMatch("1400.00", "1400.00")).toBe(true)
    expect(amountsMatch("1400.00", 1400)).toBe(true)
    expect(amountsMatch("1400", "1400.00")).toBe(true)
    expect(amountsMatch(1400.005, 1400.005)).toBe(true)
  })

  it("is false for a mismatch (even by one cent)", () => {
    expect(amountsMatch("1400.00", "1.00")).toBe(false)
    expect(amountsMatch("1400.00", "1400.01")).toBe(false)
  })

  it("fails CLOSED when EITHER side is missing/empty/non-finite", () => {
    expect(amountsMatch(undefined, "1400.00")).toBe(false)
    expect(amountsMatch("1400.00", undefined)).toBe(false)
    expect(amountsMatch(null, null)).toBe(false)
    expect(amountsMatch("", "1400.00")).toBe(false)
    expect(amountsMatch("abc", "1400.00")).toBe(false)
    expect(amountsMatch(Number.NaN, 1400)).toBe(false)
  })

  it("fails CLOSED on whitespace-only strings (Number(' ') === 0 must NOT match 0.00)", () => {
    expect(amountsMatch(" ", "0.00")).toBe(false)
    expect(amountsMatch("\t", "0.00")).toBe(false)
    expect(amountsMatch("\n", "0")).toBe(false)
    expect(amountsMatch("0.00", " ")).toBe(false)
    expect(amountsMatch("0.00", "\t")).toBe(false)
    expect(amountsMatch(" \n ", " \t ")).toBe(false)
  })

  it("still matches valid inputs that merely carry surrounding whitespace", () => {
    expect(amountsMatch(" 1400.00 ", "1400.00")).toBe(true)
    expect(amountsMatch("1400.00", " 1400.00")).toBe(true)
  })
})
