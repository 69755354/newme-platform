# Advertising provisioning replay correction

Follow-up to the existing advertising provisioning task. The three owned trigger definitions are replaced transactionally on reapply; existing spend rows must remain unchanged. The reviewed, still-unapplied SQL checksum is `76a530de097e9b7cfea8099daa642e6bbadfbc257c46fc4867af219652779487`.

The dev-only Zod peer is pinned to 4.6.6 for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). Lock generation changed only that dependency entry. Existing audit exceptions and permissions are unchanged. Required CI, guarded bootstrap, application rollout and real HTTP/worker acceptance remain mandatory. The timer remains disabled.
