// Reference spec for wallet-address.ts (not run by this package's jest config -
// it lives outside a __tests__ directory on purpose). Copy it next to your copy of
// wallet-address.ts and fix the import path.
import {
  buildWalletCartUpdate,
  mapWalletToMedusaAddress,
  mergeWalletAddress,
} from "./wallet-address"

// ── Embedded Express wallet-address mapping (Apple/Google Pay → Medusa cart address). ──
// Pure-function tests: the /status shapes here mirror the pre-GA wallet fields
// (shipping.street1 etc., blank fields omitted). The route writes ONLY what these
// helpers produce.

describe("mapWalletToMedusaAddress", () => {
  const SHIPPING = {
    street1: "1 Test Street",
    city: "Testville",
    state: "WC",
    postcode: "8001",
    country: "ZA",
  }
  const CUSTOMER = {
    givenName: "Test",
    surname: "Shopper",
    mobile: "+27000000000",
    email: "shopper@example.com",
  }

  it("maps the full wallet shipping + customer to the Medusa address shape", () => {
    expect(mapWalletToMedusaAddress(SHIPPING, CUSTOMER)).toEqual({
      first_name: "Test",
      last_name: "Shopper",
      phone: "+27000000000",
      address_1: "1 Test Street",
      city: "Testville",
      province: "WC", // ISO state passthrough: no re-mapping
      postal_code: "8001",
      country_code: "za", // upper-case Peach country lower-cased for Medusa
    })
  })

  it("omits missing fields entirely (no empty strings)", () => {
    const addr = mapWalletToMedusaAddress(
      { street1: "1 Test Street", country: "ZA" },
      { givenName: "Test" }
    )!
    expect(addr).toEqual({
      first_name: "Test",
      address_1: "1 Test Street",
      country_code: "za",
    })
    expect("last_name" in addr).toBe(false)
    expect("city" in addr).toBe(false)
    expect("province" in addr).toBe(false)
    expect("postal_code" in addr).toBe(false)
  })

  it("defaults country_code to 'za' when shipping is present without a country", () => {
    expect(mapWalletToMedusaAddress({ street1: "2 Sample Road" }, undefined)).toEqual({
      address_1: "2 Sample Road",
      country_code: "za",
    })
  })

  it("does NOT fabricate a country_code from a contact-only result (no shipping)", () => {
    expect(mapWalletToMedusaAddress(undefined, CUSTOMER)).toEqual({
      first_name: "Test",
      last_name: "Shopper",
      phone: "+27000000000",
    })
  })

  it("returns undefined when there is nothing to map", () => {
    expect(mapWalletToMedusaAddress(undefined, undefined)).toBeUndefined()
    expect(mapWalletToMedusaAddress(undefined, { email: "only@example.com" })).toBeUndefined()
  })
})

describe("mergeWalletAddress: never-overwrite", () => {
  const WALLET = {
    first_name: "Test",
    address_1: "1 Test Street",
    city: "Testville",
    country_code: "za",
  }

  it("keeps every non-empty existing field and fills only the empty ones", () => {
    const existing = {
      first_name: "Existing Name",
      city: "", // empty string counts as empty → fillable
      address_2: "Unit 4", // not a wallet field: must survive the write
      country_code: "za", // pre-set by region: kept
    }
    const { address, filled } = mergeWalletAddress(existing, WALLET)
    expect(filled).toBe(true)
    expect(address).toEqual({
      first_name: "Existing Name", // NOT overwritten
      address_2: "Unit 4", // carried over so a replace-style update can't drop it
      address_1: "1 Test Street", // filled (was absent)
      city: "Testville", // filled (was empty string)
      country_code: "za",
    })
  })

  it("reports filled=false when every wallet field is already occupied", () => {
    const existing = {
      first_name: "A",
      address_1: "9 Sample Street",
      city: "Sampleton",
      country_code: "za",
    }
    const { filled } = mergeWalletAddress(existing, WALLET)
    expect(filled).toBe(false)
  })

  it("fills everything on a missing/null existing address", () => {
    const { address, filled } = mergeWalletAddress(null, WALLET)
    expect(filled).toBe(true)
    expect(address).toEqual(WALLET)
  })
})

describe("buildWalletCartUpdate", () => {
  const STATUS = {
    shipping: { street1: "1 Test Street", city: "Testville", state: "WC", postcode: "8001", country: "ZA" },
    customer: { givenName: "Test", surname: "Shopper", mobile: "+27000000000", email: "shopper@example.com" },
  }

  it("writes email + shipping_address + billing_address (billing = shipping) on an empty cart", () => {
    const update = buildWalletCartUpdate(STATUS, {})!
    expect(update.email).toBe("shopper@example.com")
    expect(update.shipping_address).toEqual({
      first_name: "Test",
      last_name: "Shopper",
      phone: "+27000000000",
      address_1: "1 Test Street",
      city: "Testville",
      province: "WC",
      postal_code: "8001",
      country_code: "za",
    })
    // Wallets don't surface a separate billing address: billing mirrors shipping.
    expect(update.billing_address).toEqual(update.shipping_address)
  })

  it("never overwrites an existing cart email", () => {
    const update = buildWalletCartUpdate(STATUS, { email: "already@set.com" })!
    expect(update.email).toBeUndefined()
    expect(update.shipping_address).toBeDefined()
  })

  it("never overwrites existing non-empty address fields (fills only the gaps)", () => {
    const update = buildWalletCartUpdate(STATUS, {
      email: "already@set.com",
      shipping_address: { first_name: "Kept", address_1: "9 Sample Street", country_code: "za" },
    })!
    expect(update.shipping_address).toMatchObject({
      first_name: "Kept", // existing wins
      address_1: "9 Sample Street", // existing wins
      city: "Testville", // gap filled from the wallet
      postal_code: "8001",
    })
    // Billing was empty → gets the full wallet address.
    expect(update.billing_address).toMatchObject({ first_name: "Test", address_1: "1 Test Street" })
  })

  it("returns undefined when the cart is already fully addressed (nothing new to write)", () => {
    const full = {
      first_name: "A",
      last_name: "B",
      phone: "+27",
      address_1: "9 Sample Street",
      city: "CT",
      province: "WC",
      postal_code: "8000",
      country_code: "za",
    }
    const update = buildWalletCartUpdate(STATUS, {
      email: "already@set.com",
      shipping_address: full,
      billing_address: full,
    })
    expect(update).toBeUndefined()
  })

  it("returns undefined when the wallet returned nothing", () => {
    expect(buildWalletCartUpdate({}, {})).toBeUndefined()
  })

  it("writes only the email when the wallet returned an email but no address", () => {
    const update = buildWalletCartUpdate(
      { customer: { email: "only@example.com" } },
      { shipping_address: null }
    )!
    expect(update).toEqual({ email: "only@example.com" })
  })
})
