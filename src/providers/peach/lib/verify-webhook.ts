import crypto from "crypto"

export type WebhookHeaders = Record<string, string | string[] | undefined>

export interface VerifyResult {
  valid: boolean
  /** Which signing scheme matched (diagnostic). */
  scheme?: string
  reason?: string
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key]
      return Array.isArray(v) ? v[0] : v
    }
  }
  return undefined
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Scheme 1: CLASSIC Checkout (HPP / Embedded). This is what Checkout V2 actually sends.
 * Per Peach's webhook signature documentation:
 *   - body is `application/x-www-form-urlencoded`
 *   - the signature is a FIELD INSIDE the body: `signature=<hex>`
 *   - signed message = ALL other body params (INCLUDING empty-value ones) sorted
 *     alphabetically by key, concatenated as `key` + `value` with NO separators
 *     (no `=`, no `&`); HMAC-SHA256 hex with the secret token.
 * Example signed string: `amount5.00authentication.entityId8ac7..currencyZARid8ac7..paymentTypeRF`
 */
function verifyClassic(secretToken: string, rawBody: string): VerifyResult {
  const params = new URLSearchParams(rawBody)
  const signature = params.get("signature")
  if (!signature) {
    return { valid: false, reason: "missing_signature_field" }
  }
  const entries: Array<[string, string]> = []
  for (const [k, v] of params.entries()) {
    if (k !== "signature") {
      entries.push([k, v])
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const message = entries.map(([k, v]) => `${k}${v}`).join("")
  const hex = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("hex")
  if (safeEq(hex, signature)) {
    return { valid: true, scheme: "classic-checkout(sorted-kv)" }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Flatten a parsed body object back to form-urlencoded key names, so a nested
 * `customParameters: { medusaSessionId }` becomes `customParameters[medusaSessionId]`
 *: the exact key Peach signs. Dotted keys (`result.code`, `recon.authCode`) are
 * already flat and pass through unchanged.
 */
function pushParam(key: string, v: unknown, out: Array<[string, string]>): void {
  if (Array.isArray(v)) {
    // Repeated form keys (key=a&key=b) parse to an array: emit one entry per
    // element (matching URLSearchParams), NOT String(array) which joins with commas.
    for (const el of v) {
      pushParam(key, el, out)
    }
  } else if (v !== null && typeof v === "object") {
    flattenParams(v as Record<string, unknown>, key, out)
  } else {
    out.push([key, v == null ? "" : String(v)])
  }
}

function flattenParams(
  obj: Record<string, unknown>,
  prefix: string,
  out: Array<[string, string]>
): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k
    pushParam(key, v, out)
  }
}

/**
 * Classic Checkout verification when the raw body was NOT preserved. Medusa parses the
 * `application/x-www-form-urlencoded` webhook into `payload.data` (a nested object) and
 * discards the raw bytes, so we reconstruct the signed message from the parsed object:
 * flatten nested keys to bracket notation, drop `signature`, sort alphabetically, concat
 * `key`+`value` (no separator), HMAC-SHA256. PROVEN against a real sandbox webhook:
 * this exactly reproduces Peach's `signature`.
 */
function verifyClassicFromParsed(
  secretToken: string,
  data: Record<string, unknown>
): VerifyResult {
  const signature = data["signature"]
  if (typeof signature !== "string" || !signature) {
    return { valid: false, reason: "missing_signature_field" }
  }
  const entries: Array<[string, string]> = []
  for (const [k, v] of Object.entries(data)) {
    if (k === "signature") {
      continue
    }
    pushParam(k, v, entries)
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const message = entries.map(([k, v]) => `${k}${v}`).join("")
  const hex = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("hex")
  if (safeEq(hex, signature)) {
    return { valid: true, scheme: "classic-checkout(parsed-kv)" }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Scheme 2: MODERN (Payment Links V2 / header-HMAC). Kept for completeness in case a
 * webhook arrives via the header scheme. Format per Peach's webhook signature documentation:
 *   message = `${timestamp}.${webhookId}.${url}.${payload}` ; HMAC-SHA256 hex.
 * We also try a couple of nearby constructions defensively and log which matched.
 */
function verifyModern(
  secretToken: string,
  headers: WebhookHeaders,
  rawBody: string,
  url: string | undefined,
  signature: string
): VerifyResult {
  const timestamp = header(headers, "x-webhook-timestamp") ?? ""
  const webhookId = header(headers, "x-webhook-id") ?? ""
  const candidates: Record<string, string> = {
    "ts.id.url.payload": `${timestamp}.${webhookId}.${url ?? ""}.${rawBody}`,
    "ts.id.payload": `${timestamp}.${webhookId}.${rawBody}`,
  }
  for (const [scheme, message] of Object.entries(candidates)) {
    const hex = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("hex")
    if (safeEq(hex, signature)) {
      return { valid: true, scheme }
    }
    const b64 = crypto.createHmac("sha256", secretToken).update(message, "utf8").digest("base64")
    if (safeEq(b64, signature)) {
      return { valid: true, scheme: `${scheme}(base64)` }
    }
  }
  return { valid: false, reason: "signature_mismatch" }
}

/**
 * Verify a Peach webhook. Tries the CLASSIC Checkout body-signature scheme first (what we
 * actually receive), then the modern header-HMAC scheme if a signature header is present.
 *
 * Fails CLOSED: with no `secretToken` configured we return invalid, so an unverifiable
 * webhook never authorises/captures money. The primary completion path (authorize-on-return)
 * does not depend on the webhook.
 */
export function verifyPeachWebhook(opts: {
  secretToken?: string
  headers: WebhookHeaders
  rawBody: string
  url?: string
  /** Medusa's parsed body (`payload.data`): used when the raw body was not preserved. */
  parsedData?: Record<string, unknown>
}): VerifyResult {
  const { secretToken, headers, rawBody, url, parsedData } = opts

  if (!secretToken) {
    return { valid: false, reason: "no_secret_configured" }
  }

  // Classic Checkout, raw body preserved: the signature lives in the form-urlencoded body.
  const hasBodySignature = /(^|&)signature=/.test(rawBody || "")
  if (hasBodySignature) {
    const classic = verifyClassic(secretToken, rawBody)
    if (classic.valid) {
      return classic
    }
  }

  // Classic Checkout, raw body NOT preserved (Medusa parsed form-urlencoded into
  // payload.data and dropped the bytes): reconstruct + verify from the parsed object.
  const hasParsedSignature = typeof parsedData?.["signature"] === "string"
  if (hasParsedSignature) {
    const parsed = verifyClassicFromParsed(secretToken, parsedData as Record<string, unknown>)
    if (parsed.valid) {
      return parsed
    }
  }

  // Modern Payment Links: signature in the header.
  const headerSig = header(headers, "x-webhook-signature")
  if (headerSig) {
    const modern = verifyModern(secretToken, headers, rawBody, url, headerSig)
    if (modern.valid) {
      return modern
    }
    return { valid: false, reason: "signature_mismatch" }
  }

  if (hasBodySignature || hasParsedSignature) {
    return { valid: false, reason: "signature_mismatch" }
  }
  return { valid: false, reason: "missing_signature" }
}
