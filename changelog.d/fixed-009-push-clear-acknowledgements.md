- Require alias-matched outbound clear acknowledgements before Android Push overlap recovery
  re-arms using settled clear-only proofs, including removed fixture hosts. Retain typed delivery
  timeouts and late sampling at actual execution expiry without changing local-timeout or GCM
  attribution, preserve clear failure causes, and share standalone failure IDs with the runtime.
