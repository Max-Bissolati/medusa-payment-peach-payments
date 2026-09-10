// Reference code, adapt into your own storefront: this is not a dependency of
// medusa-payment-peach-payments. This is the authorize-on-return handler: the page the
// shopper lands on after paying (shopperResultUrl / the embedded widget's
// onCompleted callback both point here). It calls cart.complete() and uses the
// Peach payment session's status to tell a genuine decline from a still-
// pending payment from a payment that already settled.
//
// Adjust the `medusa` import to wherever you construct the Medusa JS SDK
// client, and the cart-id storage/retrieval to however your storefront tracks
// the shopper's active cart (localStorage here, for a guest-checkout example).

'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { medusa } from '../lib/medusa-client' // adjust to your SDK setup
import { pickActivePeachSession } from '../lib/peach'

const CART_ID_KEY = 'medusa-cart-id'

// 'completing'/'processing' are transient (still polling). 'unconfirmed' is a
// soft terminal state: the payment could not be confirmed but it is NOT a
// decline (unknown or still-pending): reassure the shopper and keep a light
// background check, never invite a second payment. 'failed' is the assertive
// terminal state, used only on a genuine decline, where retrying is correct.
type Phase = 'completing' | 'processing' | 'unconfirmed' | 'failed'

const MAX_ATTEMPTS = 6 // ~18s of polling, long enough for a delayed 3DS webhook
const RETRY_MS = 3000

// Settled-payment (authorized/captured) brief poll for the order before routing.
const SETTLE_ATTEMPTS = 4
const SETTLE_MS = 2500

// Light background completion check while showing the soft "unconfirmed" state.
const BG_ATTEMPTS = 20
const BG_MS = 6000 // ~2 minutes of quiet watching for a late webhook

export default function PeachResultContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [phase, setPhase] = useState<Phase>('completing')
  const [message, setMessage] = useState<string | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // Route to the success page. Pass the order id when we have it; without it
    // the success page can still show a truthful "thanks, confirmation coming"
    // screen. Only call this once you KNOW an order exists (cart.complete
    // returned one, or the cart shows completed_at) or the payment settled.
    const succeed = async (orderId?: string) => {
      localStorage.removeItem(CART_ID_KEY)
      // If your storefront keeps client-side cart state (a cart context,
      // SWR cache, etc.), refresh/clear it here before navigating away.
      router.replace(orderId ? `/order-confirmed?order_id=${orderId}` : '/order-confirmed')
    }

    // Read the Peach payment session's status so a genuine DECLINE
    // (error/canceled → let the shopper retry) can be told apart from a still-
    // PENDING payment (pending/requires_more → keep waiting; a slow 3DS
    // finalises via the webhook) and from a SETTLED payment
    // (authorized/captured → the order is on its way). Returns null when the
    // status couldn't be read: that's UNKNOWN, never a decline.
    const peachStatus = async (cartId: string): Promise<string | null> => {
      try {
        const { cart } = await medusa.store.cart.retrieve(cartId, {
          fields: '*payment_collection.payment_sessions',
        } as never)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessions: any[] = (cart as any)?.payment_collection?.payment_sessions || []
        // Read the status off the LIVE session (newest/pending), not the
        // first accumulated one, otherwise a stale session's status masks
        // the real one.
        const s = pickActivePeachSession(sessions)
        return s?.status ?? null
      } catch {
        return null
      }
    }

    // Order-existence signal, independent of cart.complete. A completed cart
    // has a completed_at timestamp, meaning the order was genuinely placed,
    // safe to show success. Returns null when the check itself failed.
    const orderPlaced = async (cartId: string): Promise<boolean | null> => {
      try {
        const { cart } = await medusa.store.cart.retrieve(cartId)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Boolean((cart as any)?.completed_at)
      } catch {
        return null
      }
    }

    // Payment has SETTLED (authorized/captured) but cart.complete conflicted.
    // The order either already exists (the webhook beat the redirect) or will
    // within moments. Poll briefly for the real order, then send the shopper
    // to the success page either way. The money is taken, so this is not a
    // false success, and it avoids a perpetual "processing" dead end.
    const routeSettled = async (cartId: string) => {
      for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
        try {
          const result = await medusa.store.cart.complete(cartId)
          if (result?.type === 'order') {
            await succeed(result.order.id)
            return
          }
        } catch {
          /* already completed or still finalising, fall through to the order check */
        }
        if (await orderPlaced(cartId)) {
          await succeed()
          return
        }
        await sleep(SETTLE_MS)
      }
      await succeed()
    }

    // While the shopper sees the soft "unconfirmed" screen, keep quietly
    // watching for the order to materialise from a late webhook. Upgrade to
    // the success page if it does. Fire-and-forget, never blocks the UI.
    const backgroundConfirm = async (cartId: string) => {
      for (let i = 0; i < BG_ATTEMPTS; i++) {
        await sleep(BG_MS)
        try {
          const result = await medusa.store.cart.complete(cartId)
          if (result?.type === 'order') {
            await succeed(result.order.id)
            return
          }
        } catch {
          /* keep watching */
        }
        if (await orderPlaced(cartId)) {
          await succeed()
          return
        }
      }
    }

    const enterUnconfirmed = (cartId: string) => {
      setPhase('unconfirmed')
      setMessage(null)
      void backgroundConfirm(cartId)
    }

    const run = async () => {
      const cartId = searchParams.get('cartId') || localStorage.getItem(CART_ID_KEY)

      if (!cartId) {
        // No cart id at all: the outcome is genuinely UNKNOWN, not a
        // decline. Show the soft "unconfirmed" screen, never the assertive
        // retry screen (which could invite a double-pay).
        setPhase('unconfirmed')
        setMessage(null)
        return
      }

      // Poll cart.complete: the authorize-on-return path may need a moment,
      // and a slow 3DS authorisation is finalised by the WEBHOOK. Retrying
      // here catches that (a later attempt returns the order, or an
      // already-completed conflict), so a shopper whose order will succeed is
      // never shown a failure.
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await medusa.store.cart.complete(cartId)
          if (result?.type === 'order') {
            await succeed(result.order.id)
            return
          }
          // Not an order yet. Only a genuine Peach DECLINE (error/canceled) is
          // a terminal failure; pending/unknown means keep polling.
          const st = await peachStatus(cartId)
          if (st === 'error' || st === 'canceled') {
            setPhase('failed')
            setMessage(
              result?.error?.message ||
                'Your payment was declined. No order has been placed. Please try again or use another method.'
            )
            return
          }
          if (attempt >= MAX_ATTEMPTS) {
            // Poll window done, still no order. Check whether the order
            // actually exists (a webhook may have completed it). If so,
            // success. Otherwise the payment is UNCONFIRMED (pending/
            // unknown), NOT declined: show the soft screen and keep a light
            // background check.
            if (await orderPlaced(cartId)) {
              await succeed()
              return
            }
            enterUnconfirmed(cartId)
            return
          }
          setPhase(attempt >= 2 ? 'processing' : 'completing')
        } catch (err) {
          const status = (err as { status?: number })?.status
          // cart.complete throws a 400/409 in two very different situations:
          //  (a) DECLINE / abandonment: the Peach session is stuck pending
          //      so Medusa says "session was not authorized". Terminal.
          //  (b) "already completed" conflict: the webhook beat the redirect
          //      and the order exists; the session is authorized/captured.
          // The reliable discriminators are ORDER EXISTENCE and the PEACH
          // SESSION STATUS, not the (SDK-dependent) error text.
          if (status === 400 || status === 409) {
            if (await orderPlaced(cartId)) {
              await succeed()
              return
            }
            const st = await peachStatus(cartId)
            if (st === 'authorized' || st === 'captured') {
              await routeSettled(cartId)
              return
            }
            if (st === 'error' || st === 'canceled') {
              setPhase('failed')
              setMessage(
                'Your payment was declined. No order has been placed. Please try again or use another method.'
              )
              return
            }
            if (attempt >= MAX_ATTEMPTS) {
              enterUnconfirmed(cartId)
              return
            }
            setPhase(attempt >= 2 ? 'processing' : 'completing')
            await sleep(RETRY_MS)
            continue
          }
          // Genuine error talking to the server, UNKNOWN, never a decline.
          console.error('Peach result completion error:', err)
          if (attempt >= MAX_ATTEMPTS) {
            if (await orderPlaced(cartId)) {
              await succeed()
              return
            }
            enterUnconfirmed(cartId)
            return
          }
        }
        await sleep(RETRY_MS)
      }
    }

    run()
  }, [router, searchParams])

  if (phase === 'completing' || phase === 'processing') {
    return (
      <main>
        <p>
          {phase === 'processing'
            ? 'Still confirming your payment. This is taking a little longer than usual, please keep this window open.'
            : 'Confirming your payment. Please do not close this window.'}
        </p>
      </main>
    )
  }

  if (phase === 'unconfirmed') {
    return (
      <main>
        <h1>We are still confirming your order</h1>
        <p>
          We could not confirm your payment just yet. If you completed card authentication, your
          order is most likely going through and we will email your confirmation shortly. Please
          do not pay again until you have checked your inbox.
        </p>
        <p>If anything looks off, contact support@example.com and we will confirm your order.</p>
      </main>
    )
  }

  return (
    <main>
      <h1>Let&apos;s try again</h1>
      <p>{message || 'Your payment was not completed. No order has been placed.'}</p>
      <a href="/checkout">Return to checkout</a>
      <a href="/cart">View cart</a>
    </main>
  )
}
