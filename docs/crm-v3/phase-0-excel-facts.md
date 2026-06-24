# CRM v3 — Phase 0: Excel Facts (value_counts)

Source: `/tmp/Book2.xlsx` (downloaded from COS `crm-v3/../../副本Book2.xlsx`)
Sheet: `KNX Clinent` (single sheet)
Header row: row index 3 (Excel row 4). Data region begins row index 4.
Note: sheet has a leading empty index column (all-null) which was dropped before counting; 15 effective columns remain: `ID, Ledes From, Company name, Client Name, Contact Number, Emirate / Location, Client Quality, Country/region, Date of First Contact, Project Type, System, Quotation Value, Opportunity Level, Status, Notes`.

This document reports raw counts only. No inference, no mapping.

---

## 1. 总行数 (Total Rows)

| Metric | Count |
|---|---|
| Total data rows | **61** |
| Fully-empty rows | 0 |
| Rows with non-null `ID` | 60 (1 row has null ID) |
| `ID` range | 0 … 40 (with gaps) |
| Rows empty except possibly `ID` | 9 (trailing rows carry only an `ID` value) |

---

## 2. 电话列非空数 (Contact Number non-null)

| Metric | Count |
|---|---|
| `Contact Number` non-null | **50** |
| `Contact Number` null/empty | 11 |

---

## 3. Status 分布 (value_counts)

| Value | Count |
|---|---|
| (empty / NaN) | 21 |
| `poor Leads` | 17 |
| `Under discussion` | 8 |
| `Under design` | 7 |
| `Waiting for the drawing` | 2 |
| `Good Leads` | 2 |
| `Fake Leads` | 1 |
| `Rejection` | 1 |
| ` Leads` (leading space) | 1 |
| `Under aprovall` | 1 |
| **Total** | **61** |

Observable: value casing/spelling is inconsistent (`poor Leads` / `Good Leads` / ` Leads` with leading space; `Under aprovall`).

---

## 4. Source 分布 — column `Ledes From` (value_counts)

| Value | Count |
|---|---|
| (empty / NaN) | 37 |
| `instgram` | 24 |
| **Total** | **61** |

Observable: only one distinct source value (`instgram`, note spelling).

---

## 5. Client Quality 分布 (value_counts)

| Value | Count |
|---|---|
| (empty / NaN) | 19 |
| `0` | 16 |
| `0.5` | 5 |
| `0.6` | 5 |
| `0.8` | 5 |
| `0.7` | 4 |
| `0.9` | 3 |
| `0.2` | 1 |
| `0.4` | 1 |
| `0.1` | 1 |
| `0&` | 1 |
| **Total** | **61** |

Observable: values are numeric decimals (0–0.9 scale) plus one literal `0&`.

---

## 6. 日期范围 (Date of First Contact)

| Metric | Value |
|---|---|
| Min | **2025-11-08** |
| Max | **2026-06-23** |
| Non-null dates | 52 |
| Null/empty dates | 9 |

---

## 7. Notes 抽样 (first 5 non-empty)

40 rows have non-empty `Notes`. First 5 (by sheet order):

1. ID 1 — `"Fake Leads"`
2. ID 2 — `"Fake Leads"`
3. ID 3 — `"Fake Leads"`
4. ID 4 — `"attendance device and curtain control unit"`
5. ID 5 — `"He was inquiring about a large office space that he would like to make smart."`

Observable: many `Notes` values duplicate the `Status` value (e.g. rows with Status `Fake Leads` also carry `Notes` = `Fake Leads`).

---

## 8. 重复电话检测 (Duplicate Contact Number)

| Method | Duplicate rows | Distinct duplicated values |
|---|---|---|
| Exact-string match | **0** | 0 |
| Digits-only normalized (strip all non-digits) | **0** | 0 |

50 phone values present; none repeat — even after stripping spaces/separators.

Observable: phone formats are inconsistent (e.g. `971504450540`, `971 50 173 8035`, `92 345 3057588`, `91 96608 86574`), mixing country codes and spacing.
