# Weekly ad review (switch OFF by default)

Mondays 09:10 Dubai. Reads OS data only and suggests; it never changes a Meta campaign, ad or budget.

Per ad for the last 7 whole Dubai days: spend, leads, cost per lead, good-quality leads, quotes with an amount, quote value,
plus 3-5 plain-Chinese suggestions (scale / keep / pause / test new). Delivery: WhatsApp summary to Sam and Tanya through
`newme-whatsapp-alert.sh` (same path and recipients as the S7 alerts, event `info`), and `ad-review-YYYYMMDD.csv` / `.txt`
to the NAS `exports` folder through `newme-nas-upload.sh`.

- Code: `src/lib/weekly-ad-review.mjs` (pure), `scripts/weekly-ad-review.mjs` (runner), `infra/systemd/newme-weekly-ad-review.{service,timer}`.
- Data: `ad_spend` (by ad name; it has no ad id, ambiguous names are reported, not guessed), `leads` (ad leads created in the window, not archived,
  quality good/normal by `qualityBucket`), `quotations` + `leads.quotation_value` (same amount rule as the Meta feedback: newest non-rejected quotation, else reported value; AED only).
  Quotes are counted for leads created in the window, whenever the quote was made.
- Dry run (prints, sends nothing): `node scripts/weekly-ad-review.mjs` in `/opt/newme/current` with the runtime env.

## Switch on / off
The installer only installs the units. To turn on: create `/etc/newme/weekly-ad-review.env` (mode 600) with `WEEKLY_AD_REVIEW_ENABLED=true`,
then `systemctl enable --now newme-weekly-ad-review.timer`. Off: `systemctl disable --now newme-weekly-ad-review.timer` (without the env line a run does nothing).

## Spend data
Without spend rows for the window the report still works: it ranks by good leads and quotes, shows no cost, and the first suggestion says spend is not connected.
Spend arrives in `ad_spend` only through a read-only ads sync. Needed (nothing here enables it):
1. a Meta token with `ads_read` for the ad account (system-user token `META_SYSTEM_USER_TOKEN`, or the OAuth token in `meta_tokens`) and `META_AD_ACCOUNT_ID`;
2. either the server's `newme-meta-ads-sync.timer` (currently disabled; its runner is root-only and was not readable by this account, so not reviewed here) or the app route `/api/cron/ads-sync`
   (`ADS_SYNC_CRON_ENABLED=true`, `infra/cron/newme-cron-ads-sync.timer`), which writes the last 7 days through the atomic `replace_meta_ad_spend_window`;
3. or a manual Ads Manager daily export imported with `scripts/import-ads-manager-export.mjs`.
