# NewMe CRM E2E Test Matrix
# Generated: 2026-06-10
# Roles: boss, admin, sales
# Base URL: https://app.newme.ae

## Pages × Roles × Actions

### 1. Login (/login)
| Action | Role | Expected |
|--------|------|----------|
| Valid login boss | boss | redirect /dashboard, management nav |
| Valid login sales | sales | redirect /dashboard, sales nav |
| Invalid password | any | error message shown |
| Force password change | any | redirect /change-password |

### 2. Dashboard (/dashboard)
| Action | Role | Expected |
|--------|------|----------|
| Page loads, stats visible | boss | all company stats shown |
| Page loads, stats visible | sales | only personal stats shown |
| "Add Lead" button → /leads/new | boss | navigates to new lead form |
| Card click → /leads | any | navigates to leads |
| Sales team visible | boss | shows sales users list |
| Sales team hidden | sales | no team section |
| Overdue followup alert | any | shows overdue count |

### 3. Leads List (/leads)
| Action | Role | Expected |
|--------|------|----------|
| Page loads, leads table | boss | all leads visible |
| Page loads, leads table | sales | only assigned leads |
| Quick Create dialog | any | dialog opens, form works |
| Search/filter | any | filters results |
| Bulk select + transfer | boss/admin | transfer dialog works |
| Sort by column | any | table re-sorts |
| Click lead row → detail | any | navigates to /leads/[id] |
| Pagination | any | pages through results |

### 4. Lead Detail (/leads/[id])
| Action | Role | Expected |
|--------|------|----------|
| Lead info displays | any | name, phone, status, etc. |
| Status change | any | dropdown saves new status |
| Add note/activity | any | activity created |
| Edit lead fields | any | saves successfully |
| Delete lead | boss/admin | confirm dialog, deletes |
| Back to list | any | returns to /leads |

### 5. New Lead (/leads/new)
| Action | Role | Expected |
|--------|------|----------|
| Form renders all fields | any | all inputs visible |
| Submit valid data | any | creates lead, redirects |
| Submit empty required | any | validation error shown |
| Cancel/back | any | returns to /leads |

### 6. Quotes (/quotes)
| Action | Role | Expected |
|--------|------|----------|
| Page loads, quotes list | boss | all quotes |
| Page loads, quotes list | sales | own quotes only |
| Create new quote | any | opens quote form |
| Export quote | any | downloads file |

### 7. Contracts (/contracts)
| Action | Role | Expected |
|--------|------|----------|
| Page loads, contracts list | boss | all contracts |
| Page loads, contracts list | sales | own contracts |
| New contract form | any | form renders |
| Contract detail | any | shows details |

### 8. Pipeline (/pipeline)
| Action | Role | Expected |
|--------|------|----------|
| Kanban board renders | boss | all leads in stages |
| Kanban board renders | sales | only assigned leads |
| Click lead card → detail | any | opens /leads/[id] |
| "Add Lead" button | any | navigates to /leads/new |
| Stage filter tabs | any | filters by stage |
| Percentages <= 100% | any | no overflow |

### 9. Analytics (/analytics)
| Action | Role | Expected |
|--------|------|----------|
| Page loads | boss | charts render |
| Page loads | sales | personal analytics |
| No JS errors | any | clean console |

### 10. Ads (/ads)
| Action | Role | Expected |
|--------|------|----------|
| Page loads | boss | ads data visible |
| Page blocked | sales | no data or redirect |
| Search/filter | boss | filters results |
| View mode toggle | boss | switches views |

### 11. Products (/products)
| Action | Role | Expected |
|--------|------|----------|
| Product list renders | any | products shown |
| Category filter | any | filters by category |
| Import dialog | boss/admin | dialog opens |
| Search | any | filters results |

### 12. Team (/team) — BOSS/ADMIN ONLY
| Action | Role | Expected |
|--------|------|----------|
| Page loads | boss | team list |
| Page blocked | sales | not in nav / 404 |
| Add user dialog | boss | dialog opens |
| Reset password | boss | password shown |
| Toggle user status | boss | toggles active/inactive |

### 13. Projects (/projects) — BOSS/ADMIN ONLY
| Action | Role | Expected |
|--------|------|----------|
| Page loads | boss | projects list |
| Page blocked | sales | not in nav / 404 |

### 14. Payments (/payments) — SALES ONLY
| Action | Role | Expected |
|--------|------|----------|
| Page loads | sales | payment installments |
| Record payment dialog | sales | dialog opens |
| Mark overdue | sales | marks installment |

### 15. Settings (/settings)
| Action | Role | Expected |
|--------|------|----------|
| Settings renders | boss | all tabs |
| Settings renders | sales | limited tabs |
| Bulk data assignment | boss | assignment UI works |
| KPI targets | boss | target setting works |
| Change password tab | any | password form |
| Language toggle | any | switches zh/en |

### 16. Change Password (/change-password)
| Action | Role | Expected |
|--------|------|----------|
| Form renders | any | old/new/confirm fields |
| Mismatch passwords | any | error shown |
| Too short password | any | error shown |
| Valid change | any | success, redirect |

## Cross-Cutting Tests
- i18n: every page in zh + en, no raw keys visible
- Auth: unauthenticated → /login redirect
- RLS: sales never sees other sales' data
- Console: no JS errors on any page
- Responsive: sidebar mobile toggle works
