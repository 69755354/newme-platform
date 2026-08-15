# NewMe CRM Test Matrix v1

## Roles
- admin (admin@newme.ae / — redacted; rotate per supabase/preflight/f02-credential-cutover.md §7)
- boss (tanya@newme.ae / — redacted; rotate per supabase/preflight/f02-credential-cutover.md §7)
- sales (faheem@newme.ae / — redacted; rotate per supabase/preflight/f02-credential-cutover.md §7)
- operator — TODO: no test account yet

## Pages × Expected Access
| Page | admin | boss | sales | operator |
|------|-------|------|-------|----------|
| /dashboard | ✅ | ✅ | ✅ (My Desk) | ✅ |
| /leads | ✅ all | ✅ all | ✅ own only | ✅ all? |
| /leads/new | ✅ | ✅ | ✅ | ✅ |
| /quotes | ✅ | ✅ | ✅ (Products & Quotes) | ✅ |
| /contracts | ✅ | ✅ | ✅ (My Contracts) | ✅ |
| /contracts/new | ✅ | ✅ | ✅ | ✅ |
| /pipeline | ✅ | ✅ | ❌ (no sidebar link) | ? |
| /analytics | ✅ | ✅ | ✅ (My Stats) | ? |
| /ads | ✅ | ✅ | ❌ | ❌ |
| /products | ✅ | ✅ | ✅ | ✅ |
| /team | ✅ | ✅ | ❌ (role guard) | ? |
| /settings | ✅ | ✅ | ❌ (role guard) | ? |
| /projects | ✅ | ✅ | ❌ | ? |

## Operations per Page
### /leads
- [ ] Page loads without error
- [ ] Data count matches role (admin: 281, sales: 7)
- [ ] Create lead button → form opens
- [ ] Submit empty form → validation error
- [ ] Submit valid form → lead created
- [ ] Click lead → detail page loads
- [ ] Move stage button → stage changes
- [ ] Quick Note → modal opens, can submit
- [ ] Actions dropdown → options show
- [ ] ↔️ reassign → dropdown shows (admin only)
- [ ] Bulk select → checkboxes work
- [ ] Search filter → results filter
- [ ] Stage filter → results filter
- [ ] i18n toggle → all text switches language
- [ ] No raw i18n keys visible (leads.nextActionLabels.*)

### /leads/new
- [ ] Form renders all fields
- [ ] Required field validation
- [ ] Submit creates lead → redirects to /leads

### /quotes
- [ ] Page loads
- [ ] Create quote flow works

### /contracts
- [ ] Page loads
- [ ] Contract list shows

### /contracts/new
- [ ] Form renders
- [ ] Fetches leads for dropdown
- [ ] Submit creates contract

### /settings
- [ ] Admin: page loads with all settings
- [ ] Sales: blocked (role guard)

### /team
- [ ] Admin: shows team members
- [ ] Sales: blocked (role guard)

### /products
- [ ] Page loads with product list
- [ ] All roles can access

## API Security Tests
For each API endpoint, test with each role's token:
- GET /api/activities → 200 (own) / 403 (others)?
- GET /api/dashboard/pipeline-funnel → sales: own data only
- POST /api/leads → creates with assigned_to = self for sales
- All endpoints require auth (no anonymous access)

## Data Isolation Tests
- Sales user: GET /rest/v1/leads → only leads where assigned_to = self
- Sales user: cannot update lead assigned to another sales
- Admin: can see all leads

## i18n Completeness
- Every visible text has translation (no raw keys)
- Chinese toggle works on all pages
- DB values (next_action, source, stage) all have translations
