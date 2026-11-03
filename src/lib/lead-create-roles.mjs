/**
 * Roles that may create a lead (policy_leads_insert_admin / _boss / _sales in
 * supabase/migrations/20260630200000_rls_policy_remediation.sql and
 * 20260701000003_drop_final_for_all.sql; operator is in the admin policy).
 * finance and designer have no INSERT policy, so the leads page hides the
 * create and import buttons from them (OS fix S2). A .mjs module so node --test
 * imports the value the page ships.
 */
export const LEAD_CREATE_ROLES = Object.freeze(["admin", "boss", "operator", "sales"]);
