// Reference code, adapt into your own storefront: this is not a dependency of
// medusa-payment-peach-payments. This is the embedded-widget mount: it loads the Peach
// Checkout SDK, renders it into a container once a payment session exists, and
// re-initiates on expiry. Adjust the imports (this assumes Next.js's
// next/script and a local ./lib/peach) and the styling to your own project.

'use client'

import Script from 'next/script'
import { useEffect, useRef, useState } from 'react'
import {
  PeachCheckoutInstance,
  PeachSessionData,
  SANDBOX_SDK_URL,
  buildResultUrl,
} from './lib/peach'

interface CheckoutPaymentProps {
  // Whether the payment step is unlocked yet (e.g. address + shipping method
  // already collected). The widget only mounts once this is true.
  unlocked: boolean
  // The Peach session data (checkoutId, entityId, sdkUrl...) once a payment
  // session has been initiated. Null until then.
  session: PeachSessionData | null
  // Kick off (or re-initiate) a Peach payment session against your Medusa
  // cart. Should call medusa.store.payment.initiatePaymentSession(cart, {
  // provider_id: PEACH_PROVIDER_ID, data: {...} }), then re-retrieve the cart
  // and return getPeachSessionData(cart). Returns null on failure.
  initiateSession: () => Promise<PeachSessionData | null>
  // Bubbled up so the surrounding page can show inline errors.
  onError: (message: string | null) => void
}

export default function CheckoutPayment({
  unlocked,
  session,
  initiateSession,
  onError,
}: CheckoutPaymentProps) {
  const [sdkReady, setSdkReady] = useState(false)
  const [initiating, setInitiating] = useState(false)
  const widgetRef = useRef<PeachCheckoutInstance | null>(null)
  const mountedCheckoutId = useRef<string | null>(null)

  const sdkUrl = session?.sdkUrl || SANDBOX_SDK_URL

  // Initiate a session as soon as the payment step unlocks (and we don't
  // already have one). This component doesn't own the network call itself:
  // the parent page does, so it can also update cart totals, shipping, etc.
  useEffect(() => {
    if (!unlocked) return
    if (session?.checkoutId) return
    let cancelled = false
    setInitiating(true)
    initiateSession()
      .catch(() => null)
      .finally(() => {
        if (!cancelled) setInitiating(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, session?.checkoutId])

  // Render the embedded widget once the SDK is ready and we have a checkoutId.
  // checkoutId is single-use, not reusable after unmount(), so this tracks
  // which one is currently mounted and tears down before mounting a new one.
  useEffect(() => {
    if (!sdkReady) return
    if (!session?.checkoutId || !session?.entityId) return
    if (typeof window === 'undefined' || !window.Checkout) return
    if (mountedCheckoutId.current === session.checkoutId) return

    if (widgetRef.current?.unmount) {
      try {
        widgetRef.current.unmount()
      } catch {
        /* noop */
      }
    }

    try {
      const instance = window.Checkout.initiate({
        key: session.entityId,
        checkoutId: session.checkoutId,
        // `eventHandlers` is the current SDK property; `events` is a
        // deprecated alias that still works but shouldn't be used in new code.
        eventHandlers: {
          onCompleted: () => {
            // The shopper finished in the widget. Send them to the result
            // page, which calls cart.complete().
            window.location.href = buildResultUrl()
          },
          onCancelled: () => {
            onError('Payment was cancelled. You can try again when you are ready.')
          },
          onError: () => {
            onError('Your payment could not be processed. Please check your details and try again.')
          },
          onExpired: () => {
            // 30-minute checkoutId expiry: re-initiate to get a fresh one.
            mountedCheckoutId.current = null
            onError(null)
            initiateSession().catch(() => null)
          },
        },
        customisations: {
          // Only a handful of fields cross into the widget's cross-origin
          // iframe (font family + a couple of colours). See the SDK
          // reference for the full customisable surface. Replace with your
          // own theme, or drop this key entirely for Peach's default styling.
          theme: {
            fontFamily: 'system-ui',
            brand: { primary: '#111111' },
          },
        },
      })
      instance.render('#peach-embedded-payment')
      widgetRef.current = instance
      mountedCheckoutId.current = session.checkoutId
    } catch (err) {
      console.error('Peach embedded render failed:', err)
      onError('We could not load the secure payment form. Please refresh and try again.')
    }

    return () => {
      if (widgetRef.current?.unmount) {
        try {
          widgetRef.current.unmount()
        } catch {
          /* noop */
        }
      }
      mountedCheckoutId.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdkReady, session?.checkoutId, session?.entityId])

  return (
    <section>
      {/* Load the Peach Checkout SDK from the session's sdkUrl (sandbox vs
          production; the provider picks the right one for you). */}
      {unlocked ? (
        <Script src={sdkUrl} strategy="afterInteractive" onReady={() => setSdkReady(true)} />
      ) : null}

      <h2>Payment</h2>

      {!unlocked ? (
        <p>Enter your delivery details to unlock payment.</p>
      ) : (
        <div>
          {/* The widget needs an explicit height (≥640px, or 100%/100vh) and
              must exist in the DOM before Checkout.initiate() runs, or you get
              a "Checkout not found" error. */}
          <div id="peach-embedded-payment" style={{ minHeight: 640 }}>
            {(!sdkReady || initiating || !session?.checkoutId) && <p>Loading secure payment...</p>}
          </div>
        </div>
      )}
    </section>
  )
}
