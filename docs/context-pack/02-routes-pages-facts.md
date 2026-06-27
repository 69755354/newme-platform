# 02 — Routes & Pages Facts

Source: Code scan of src/app/ + file system

## Login & Auth
| Route | File | Exists |
|---|---|---|
| /login | src/app/login/page.tsx | ✅ |
| /auth/callback | src/app/auth/callback/route.ts | ✅ |

## Dashboard Group
| Route | File | Exists | Notes |
|---|---|---|---|
| / | src/app/(dashboard)/page.tsx | ✅ | Redirects → /dashboard |
| /dashboard | src/app/(dashboard)/dashboard/page.tsx | ✅ | Main dashboard |
| /leads | src/app/(dashboard)/leads/page.tsx | ✅ | Leads list |
| /leads/[id] | src/app/(dashboard)/leads/[id]/page.tsx | ✅ | Lead detail page |
| /leads/new | src/app/(dashboard)/leads/new/page.tsx | ✅ | Create lead form |
| /pipeline | src/app/(dashboard)/pipeline/page.tsx | ✅ | Pipeline kanban board |
| /contracts | src/app/(dashboard)/contracts/page.tsx | ✅ | Contracts list |
| /contracts/new | src/app/(dashboard)/contracts/new/page.tsx | ✅ | New contract form |
| /payments | src/app/(dashboard)/payments/page.tsx | ✅ | Payments tracking |
| /projects | src/app/(dashboard)/projects/page.tsx | ✅ | Project management |
| /quotes | src/app/(dashboard)/quotes/page.tsx | ✅ | Quotation management |
| /analytics | src/app/(dashboard)/analytics/page.tsx | ✅ | Sales analytics |
| /command-center | src/app/(dashboard)/command-center/page.tsx | ✅ | CEO Command Center |
| /workbench | src/app/(dashboard)/workbench/page.tsx | ✅ | Sales workbench (hidden in nav) |
| /settings | src/app/(dashboard)/settings/page.tsx | ✅ | Settings |
| /settings/ads | src/app/(dashboard)/settings/ads/page.tsx | ✅ | Ads settings |
| /team | src/app/(dashboard)/team/page.tsx | ✅ | Team management |
| /products | src/app/(dashboard)/products/page.tsx | ✅ | Product catalog |
| /ads | src/app/(dashboard)/ads/page.tsx | ✅ | Meta Ads analysis |

## Pages Modified in Working Tree (NOT deployed)
- ads/page.tsx
- analytics/_components/SalesLoad.tsx
- analytics/_components/WeeklyTrends.tsx
- command-center/page.tsx
- contracts/new/page.tsx
- dashboard/page.tsx
- leads/[id]/page.tsx
- leads/new/page.tsx
- leads/page.tsx
- pipeline/page.tsx
- quotes/quotes-client.tsx
- settings/ads/page.tsx
- settings/page.tsx
