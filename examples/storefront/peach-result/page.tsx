// Reference code, adapt into your own storefront: this is not a dependency of
// medusa-payment-peach-payments. Next.js App Router page for the shopperResultUrl
// route. Wraps the client component in Suspense because it reads
// useSearchParams(). Adjust the metadata and loading fallback to your project.

import { Suspense } from 'react'
import PeachResultContent from './peach-result-content'

export const metadata = {
  title: 'Confirming payment',
  robots: { index: false, follow: false },
}

export default function Page() {
  return (
    <Suspense fallback={<main>Loading...</main>}>
      <PeachResultContent />
    </Suspense>
  )
}
