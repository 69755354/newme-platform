# 05 — Auth, Roles & Permissions Facts

Source: Production profiles table

## Active Employees

| Email | Name | Role | Profile ID |
|---|---|---|---|
| dev@newme.ae | Dev User | admin | 4d9da99d-c643-4ff9-88e0-094110612a92 |
| ayana@newme.ae | Ayana | admin | 6c636722-88fc-4d19-8d6a-bf899296aea2 |
| mohamed@newme.ae | Mohamed | sales | 3666d8d0-baf4-45cb-8e7f-4243c999b2b1 |
| faheem@newme.ae | Faheem | sales | 4dc710b5-9e5c-4ad6-a601-0a4f5945cba1 |
| tanya@newme.ae | Tanya | boss | 5c766c35-fda0-4077-a7b0-478b0bbb85b4 |
| admin@newme.ae | SAM | admin | 55d69083-1a27-46f3-854e-8467506fb082 |

## Leads by stage (production)

- contacted: 28
- fake: 19
- no_answered: 7
- lost: 7
- requirement_confirmed: 3
- quotation_submitted: 2
- solution_submitted: 2
- negotiation: 1

## Leads by final_status (production)

- NULL (active): 61
- lost: 8

## Leads by source (production)

- meta_ads: 35
- other: 31
- whatsapp: 2
- offline: 1

## Auth Facts
- Provider: Supabase Auth (email/password)
- Session: cookie-based (sb-access-token + sb-refresh-token)
- RLS: enabled on all tables
- Roles in profiles: boss, admin, sales, finance, operator
- service_role key: used in 21 API routes
