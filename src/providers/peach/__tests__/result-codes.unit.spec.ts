import { mapResultCodeToAction, mapResultCodeToStatus, isSuccessful } from "../lib/result-codes"

describe("mapResultCodeToStatus", () => {
  // ── Full captured table (the ONLY codes that may take money). ──
  it.each([
    "000.000.000",
    "000.100.110",
    "000.100.112",
    "000.400.000",
    "000.400.100",
    "000.400.110",
    "000.400.120",
  ])("maps %s to captured", (code) => {
    expect(mapResultCodeToStatus(code)).toBe("captured")
  })

  it("maps 000.300.* and 000.600.* (manual review / chargeback handling) to captured", () => {
    expect(mapResultCodeToStatus("000.300.000")).toBe("captured")
    expect(mapResultCodeToStatus("000.600.000")).toBe("captured")
  })

  // ── Codes that WERE wrongly bucketed as captured and must now be error (fail closed). ──
  it.each([
    "000.100.201", // chargeback / reversal family: NOT a successful capture
    "000.100.220",
    "000.100.230",
    "000.400.101", // "card not participating / authentication unavailable": 3DS-step, Rejected per Peach docs
    "000.400.102", // "user not enrolled": 3DS-step, not a terminal capture
    "000.400.103", // technical
    "000.400.104",
    "000.400.107",
    "000.400.121", // risk-rejected
    "000.400.199",
  ])("maps %s to error (previously over-matched as captured)", (code) => {
    expect(mapResultCodeToStatus(code)).toBe("error")
  })

  it("still maps 000.100.000 to error (000.100 narrowed to 000.100.1)", () => {
    expect(mapResultCodeToStatus("000.100.000")).toBe("error")
  })

  it("maps pending codes to pending", () => {
    expect(mapResultCodeToStatus("000.200.000")).toBe("pending")
    expect(mapResultCodeToStatus("000.200.100")).toBe("pending")
    expect(mapResultCodeToStatus("800.400.500")).toBe("pending")
    expect(mapResultCodeToStatus("100.400.500")).toBe("pending")
  })

  it("maps SCA / timeout codes to requires_more", () => {
    expect(mapResultCodeToStatus("300.100.100")).toBe("requires_more")
    expect(mapResultCodeToStatus("900.100.300")).toBe("requires_more")
    expect(mapResultCodeToStatus("900.100.400")).toBe("requires_more")
  })

  it("maps user-cancelled / uncertain codes to canceled (not error: so a late webhook won't downgrade)", () => {
    expect(mapResultCodeToStatus("100.396.101")).toBe("canceled") // cancelled by user
    expect(mapResultCodeToStatus("100.396.104")).toBe("canceled") // uncertain / probably cancelled
  })

  it("maps declines / errors to error", () => {
    expect(mapResultCodeToStatus("800.100.100")).toBe("error") // unchanged reference
    expect(mapResultCodeToStatus("800.100.150")).toBe("error") // issuer decline
    expect(mapResultCodeToStatus("800.120.100")).toBe("error") // limit
    expect(mapResultCodeToStatus("600.200.500")).toBe("error") // config
    expect(mapResultCodeToStatus("999.999.999")).toBe("error")
  })

  it("treats missing code as pending (not an error)", () => {
    expect(mapResultCodeToStatus(undefined)).toBe("pending")
    expect(mapResultCodeToStatus(null)).toBe("pending")
    expect(mapResultCodeToStatus("")).toBe("pending")
  })
})

// ── Regression guard for the regex hardening (trim/reject + full-token match + digits-only
// class). Every REAL code below was snapshotted from the pre-hardening implementation and
// must map identically after it; only the junk-input rows are allowed to change. ──
describe("mapResultCodeToStatus: full mapping table (hardening must not move any real code)", () => {
  it.each([
    // real Peach codes: snapshot of pre-hardening behavior, asserted unchanged
    ["000.000.000", "captured"],
    ["000.100.110", "captured"],
    ["000.100.112", "captured"],
    ["000.400.000", "captured"],
    ["000.400.100", "captured"],
    ["000.400.110", "captured"],
    ["000.400.120", "captured"],
    ["000.300.000", "captured"],
    ["000.600.000", "captured"],
    ["000.100.201", "error"],
    ["000.100.220", "error"],
    ["000.100.230", "error"],
    ["000.400.101", "error"],
    ["000.400.102", "error"],
    ["000.400.103", "error"],
    ["000.400.104", "error"],
    ["000.400.107", "error"],
    ["000.400.121", "error"],
    ["000.400.199", "error"],
    ["000.100.000", "error"],
    ["000.200.000", "pending"],
    ["000.200.100", "pending"],
    ["800.400.500", "pending"],
    ["100.400.500", "pending"],
    ["300.100.100", "requires_more"],
    ["900.100.300", "requires_more"],
    ["900.100.400", "requires_more"],
    ["100.396.101", "canceled"],
    ["100.396.104", "canceled"],
    ["800.100.100", "error"],
    ["800.100.150", "error"],
    ["800.120.100", "error"],
    ["600.200.500", "error"],
    ["999.999.999", "error"],
  ] as const)("maps %s to %s (identical to pre-hardening snapshot)", (code, expected) => {
    expect(mapResultCodeToStatus(code)).toBe(expected)
  })

  it.each([
    "000.000.000extra", // trailing junk: full-token match rejects it (was captured)
    "000.000.000\n", // trailing newline: whitespace rejection (was captured)
    " 000.000.000", // leading space: whitespace rejection
    "000.000.000\nanything", // newline-embedded junk must not match success
    "000.400.0X", // non-digit in the tightened [0-24-9] class (was captured)
  ])("junk input %j is NOT success (fail closed to error)", (code) => {
    expect(mapResultCodeToStatus(code)).toBe("error")
    expect(isSuccessful(code)).toBe(false)
  })

  it("junk success-lookalikes never authorize/capture via mapResultCodeToAction either", () => {
    expect(mapResultCodeToAction("000.000.000extra")).toBe("failed")
    expect(mapResultCodeToAction("000.000.000\n")).toBe("failed")
  })
})

describe("mapResultCodeToAction", () => {
  it("maps to webhook actions", () => {
    expect(mapResultCodeToAction("000.000.000")).toBe("captured")
    expect(mapResultCodeToAction("000.200.000")).toBe("pending")
    expect(mapResultCodeToAction("300.100.100")).toBe("requires_more")
    expect(mapResultCodeToAction("800.100.150")).toBe("failed")
    expect(mapResultCodeToAction("100.396.101")).toBe("canceled")
  })
})

describe("isSuccessful", () => {
  it("is true only for money-taken outcomes", () => {
    expect(isSuccessful("000.000.000")).toBe(true)
    expect(isSuccessful("000.200.000")).toBe(false)
    expect(isSuccessful("800.100.150")).toBe(false)
  })
})
