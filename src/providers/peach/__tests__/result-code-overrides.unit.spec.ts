import { isSuccessful, mapResultCodeToAction, mapResultCodeToStatus } from "../lib/result-codes"
import { PeachResultCodeOverrides } from "../types"

// ── resultCodeOverrides: a merchant-supplied per-code map checked BEFORE the built-in
//    regex buckets. Upgrading a fail-closed default (error/decline) to a success status
//    warns once per code. With no overrides, behaviour is identical to the built-in map. ──

// Silence + capture the fail-closed upgrade warning across the whole file.
let warnSpy: jest.SpyInstance
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  warnSpy.mockRestore()
})

describe("resultCodeOverrides: applied before the built-in map", () => {
  it("an override wins over the built-in bucket", () => {
    const overrides: PeachResultCodeOverrides = { "000.400.101": "captured" }
    // built-in: error (fail closed); override: captured
    expect(mapResultCodeToStatus("000.400.101", overrides)).toBe("captured")
  })

  it("codes NOT in the overrides map still use the built-in buckets", () => {
    const overrides: PeachResultCodeOverrides = { "000.400.101": "captured" }
    expect(mapResultCodeToStatus("000.000.000", overrides)).toBe("captured")
    expect(mapResultCodeToStatus("000.200.000", overrides)).toBe("pending")
    expect(mapResultCodeToStatus("800.100.150", overrides)).toBe("error")
  })

  it("can also downgrade a built-in success (no warning needed for that direction)", () => {
    const overrides: PeachResultCodeOverrides = { "000.300.000": "pending" }
    expect(mapResultCodeToStatus("000.300.000", overrides)).toBe("pending")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("mapResultCodeToAction respects overrides", () => {
    const overrides: PeachResultCodeOverrides = { "000.400.103": "authorized" }
    expect(mapResultCodeToAction("000.400.103", overrides)).toBe("authorized")
    expect(mapResultCodeToAction("000.400.103")).toBe("failed")
  })

  it("isSuccessful respects overrides", () => {
    const overrides: PeachResultCodeOverrides = { "000.400.104": "captured" }
    expect(isSuccessful("000.400.104", overrides)).toBe(true)
    expect(isSuccessful("000.400.104")).toBe(false)
  })

  it("a missing code is still pending, overrides or not", () => {
    expect(mapResultCodeToStatus(undefined, { "x": "captured" })).toBe("pending")
    expect(mapResultCodeToStatus(null, { "x": "captured" })).toBe("pending")
  })
})

describe("resultCodeOverrides: fail-closed upgrade warning", () => {
  it("warns when an override upgrades a built-in error/decline to a success status", () => {
    const overrides: PeachResultCodeOverrides = { "800.100.199": "captured" }
    expect(mapResultCodeToStatus("800.100.199", overrides)).toBe("captured")
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("800.100.199"))
  })

  it("warns only ONCE per code across repeated calls", () => {
    const overrides: PeachResultCodeOverrides = { "800.100.198": "authorized" }
    mapResultCodeToStatus("800.100.198", overrides)
    mapResultCodeToStatus("800.100.198", overrides)
    mapResultCodeToStatus("800.100.198", overrides)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it("does NOT warn when the override maps to a non-success status", () => {
    const overrides: PeachResultCodeOverrides = { "800.100.197": "requires_more" }
    expect(mapResultCodeToStatus("800.100.197", overrides)).toBe("requires_more")
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("does NOT warn when the built-in bucket was already a success", () => {
    const overrides: PeachResultCodeOverrides = { "000.000.000": "authorized" }
    expect(mapResultCodeToStatus("000.000.000", overrides)).toBe("authorized")
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe("resultCodeOverrides: no-override behaviour is unchanged", () => {
  it("with no overrides argument, every bucket matches the built-in map", () => {
    const cases: Array<[string, string]> = [
      ["000.000.000", "captured"],
      ["000.100.110", "captured"],
      ["000.400.101", "error"],
      ["000.200.000", "pending"],
      ["800.400.500", "pending"],
      ["300.100.100", "requires_more"],
      ["100.396.101", "canceled"],
      ["800.100.150", "error"],
    ]
    for (const [code, expected] of cases) {
      expect(mapResultCodeToStatus(code)).toBe(expected)
      expect(mapResultCodeToStatus(code, undefined)).toBe(expected)
      expect(mapResultCodeToStatus(code, {})).toBe(expected)
    }
  })
})
