# Embedded Express (Apple/Google Pay) wallet-address recipe

Optional reference code for the Embedded Express flow: after the wallet sheet completes, the shopper's address lives only on Peach's `GET /v2/checkout/{id}/status`. These files copy it onto the Medusa cart before `cart.complete`.

Copy `wallet-address.ts` and the route into your own Medusa app (for example `src/api/store/peach/apply-wallet-address/route.ts`) and adjust the imports as noted in each file. This directory is not compiled or shipped with the package.
