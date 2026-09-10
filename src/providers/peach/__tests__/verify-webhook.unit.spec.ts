import crypto from "crypto"
import { verifyPeachWebhook } from "../lib/verify-webhook"

const SECRET = "test_secret_token_abc123"
const TS = "1718700000"
const ID = "wh_12345"
const URL = "https://api.example.com/hooks/payment/peach_checkout"
const BODY = "result.code=000.000.000&merchantTransactionId=abcdef123456&amount=15000.00&customParameters%5BmedusaSessionId%5D=payses_01J"

function sign(message: string, encoding: "hex" | "base64" = "hex"): string {
  return crypto.createHmac("sha256", SECRET).update(message, "utf8").digest(encoding)
}

describe("verifyPeachWebhook", () => {
  it("fails closed when no secret is configured", () => {
    const r = verifyPeachWebhook({ headers: {}, rawBody: BODY })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("no_secret_configured")
  })

  it("fails when no signature is present (neither header nor body field)", () => {
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: BODY })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("missing_signature")
  })

  // ── Classic Checkout scheme (what Checkout V2 actually sends): signature in the body,
  //    signed over sorted params concatenated key+value with NO separator. ──
  const classicSign = (fields: Record<string, string>): string => {
    const msg = Object.keys(fields)
      .sort()
      .map((k) => `${k}${fields[k]}`)
      .join("")
    return crypto.createHmac("sha256", SECRET).update(msg, "utf8").digest("hex")
  }

  it("verifies the classic Checkout body-signature scheme (sorted key+value, empty params included)", () => {
    const fields: Record<string, string> = {
      amount: "5.00",
      "authentication.entityId": "ENTITY00TEST",
      currency: "ZAR",
      id: "TXN00000TEST",
      merchantTransactionId: "", // empty value MUST still be included in the signed string
      paymentType: "RF",
    }
    const params = new URLSearchParams(fields)
    params.set("signature", classicSign(fields))
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    expect(r.valid).toBe(true)
    expect(r.scheme).toContain("classic")
  })

  it("rejects a tampered classic body", () => {
    const fields: Record<string, string> = {
      amount: "5.00",
      "authentication.entityId": "ENTITY00TEST",
      currency: "ZAR",
      id: "TXN00000TEST",
      paymentType: "RF",
    }
    const params = new URLSearchParams(fields)
    params.set("signature", classicSign(fields))
    params.set("amount", "99999.00") // attacker inflates the amount after signing
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("rejects classic body signed with the wrong secret", () => {
    const fields: Record<string, string> = { amount: "5.00", currency: "ZAR", id: "x", paymentType: "RF" }
    const msg = Object.keys(fields).sort().map((k) => `${k}${fields[k]}`).join("")
    const params = new URLSearchParams(fields)
    params.set("signature", crypto.createHmac("sha256", "wrong").update(msg).digest("hex"))
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: params.toString() })
    expect(r.valid).toBe(false)
  })

  it("verifies the documented 4-component scheme (ts.id.url.payload)", () => {
    const sig = sign(`${TS}.${ID}.${URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: URL,
    })
    expect(r.valid).toBe(true)
    expect(r.scheme).toBe("ts.id.url.payload")
  })

  it("verifies the 3-component scheme (ts.id.payload)", () => {
    const sig = sign(`${TS}.${ID}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
    })
    expect(r.valid).toBe(true)
    expect(r.scheme).toBe("ts.id.payload")
  })

  it("accepts a base64-encoded signature", () => {
    const sig = sign(`${TS}.${ID}.${URL}.${BODY}`, "base64")
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: URL,
    })
    expect(r.valid).toBe(true)
    expect(r.scheme).toContain("base64")
  })

  it("rejects a tampered body", () => {
    const sig = sign(`${TS}.${ID}.${URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY.replace("000.000.000", "800.100.150"), // attacker flips decline -> success
      url: URL,
    })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("rejects a wrong secret", () => {
    const sig = crypto.createHmac("sha256", "wrong").update(`${TS}.${ID}.${URL}.${BODY}`).digest("hex")
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "x-webhook-signature": sig, "x-webhook-timestamp": TS, "x-webhook-id": ID },
      rawBody: BODY,
      url: URL,
    })
    expect(r.valid).toBe(false)
  })

  it("is case-insensitive on header names", () => {
    const sig = sign(`${TS}.${ID}.${URL}.${BODY}`)
    const r = verifyPeachWebhook({
      secretToken: SECRET,
      headers: { "X-Webhook-Signature": sig, "X-Webhook-Timestamp": TS, "X-Webhook-Id": ID },
      rawBody: BODY,
      url: URL,
    })
    expect(r.valid).toBe(true)
  })
})

// ── Parsed-data scheme: Medusa drops the raw form body for application/x-www-form-
//    urlencoded webhooks, so we reconstruct + verify from payload.data. Mirrors the
//    REAL sandbox payload shape (nested customParameters, dotted keys). ──
describe("verifyPeachWebhook: classic from parsed payload.data", () => {
  const flatten = (obj: Record<string, unknown>, prefix: string, out: Array<[string, string]>) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k
      if (Array.isArray(v)) v.forEach((el) => out.push([key, String(el)]))
      else if (v !== null && typeof v === "object") flatten(v as Record<string, unknown>, key, out)
      else out.push([key, v == null ? "" : String(v)])
    }
  }
  const parsedSign = (data: Record<string, unknown>): string => {
    const entries: Array<[string, string]> = []
    for (const [k, v] of Object.entries(data)) {
      if (k === "signature") continue
      if (Array.isArray(v)) v.forEach((el) => entries.push([k, String(el)]))
      else if (v !== null && typeof v === "object") flatten(v as Record<string, unknown>, k, entries)
      else entries.push([k, v == null ? "" : String(v)])
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    return sign(entries.map(([k, v]) => `${k}${v}`).join(""))
  }
  const samplePayload = (): Record<string, unknown> => ({
    amount: "1400.00",
    "result.code": "000.100.110",
    checkoutId: "CHECKOUT00000000000000000000TEST",
    currency: "ZAR",
    customParameters: { medusaSessionId: "payses_01KVDRWBMY2Q6E7TA3XZP5QGJK" },
    paymentBrand: "VISA",
    "recon.authCode": "006887",
  })

  it("verifies a valid parsed payload (nested customParameters) with rawBody empty", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    expect(r.valid).toBe(true)
    expect(r.scheme).toBe("classic-checkout(parsed-kv)")
  })

  it("rejects a tampered amount (signature mismatch): fails closed", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    data.amount = "1.00" // tamper after signing
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("rejects a wrong secret", () => {
    const data = samplePayload()
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: "wrong", headers: {}, rawBody: "", parsedData: data })
    expect(r.valid).toBe(false)
  })

  it("returns missing_signature when parsed data has no signature field", () => {
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: samplePayload() })
    expect(r.valid).toBe(false)
    expect(r.reason).toBe("missing_signature")
  })

  it("handles repeated/array keys per-element (not String(array))", () => {
    const data: Record<string, unknown> = { amount: "10.00", tags: ["a", "b"], currency: "ZAR" }
    data.signature = parsedSign(data)
    const r = verifyPeachWebhook({ secretToken: SECRET, headers: {}, rawBody: "", parsedData: data })
    expect(r.valid).toBe(true)
  })
})
