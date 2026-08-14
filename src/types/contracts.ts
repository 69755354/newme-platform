/**
 * The contracts list's read model, declared once.
 *
 * Round-4 finding R5, the same shape as B8 one table over: GET
 * /api/contracts/list returned `select("*, …")` cast to `as any[]`, and
 * src/app/(dashboard)/contracts/page.tsx declared its own `interface Contract`.
 * Neither was checked against the other, and the cast at the boundary is what kept
 * TypeScript from noticing they disagreed:
 *
 *   * the page declared `first_payment_status?: string` and `installment_plans[].
 *     paid_amount: number`. Both are wrong about the database — first_payment_status
 *     is NOT NULL (B2 made it trigger-maintained and unforgeable) and paid_amount is
 *     nullable — so the page renders `c.first_payment_status && …` on a column that
 *     is never absent and treats a null paid_amount as a number.
 *   * `installment_plans[].allocated_amount` was not declared at all, so the list
 *     could not tell an installment that has money allocated against it from one
 *     that has been paid — which is the same field B8's payments page needed.
 *
 * So the columns are named in the route, the row type is derived from the generated
 * database types, and both sides import this file. Deriving rather than restating
 * means a column that changes type in src/types/database.ts breaks the build here
 * instead of being silently mis-rendered.
 */
import type { Database } from "./database"

type ContractRow = Database["public"]["Tables"]["contracts"]["Row"]
type InstallmentRow = Database["public"]["Tables"]["installment_plans"]["Row"]

/**
 * An installment as the list receives it.
 *
 * `allocated_amount` and `paid_amount` are both here because they are different
 * questions: allocate_payment() writes the first from payment_allocations, and the
 * paid total is what the trigger maintains. The list's badge must not read one for
 * the other.
 */
export type ContractListInstallment = Pick<
  InstallmentRow,
  "id" | "amount" | "due_date" | "status" | "paid_amount" | "allocated_amount" | "seq"
>

/**
 * A contracts row as the list page receives it.
 *
 * The columns are the ones the page renders, plus `lead_id` and `sales_id`, which it
 * uses for links and for the ownership-dependent actions. Everything else the old
 * `*` returned — file_url, sealed_file_metadata, notes, party_b_*, terminated_* — is
 * left on the server: nothing on this page reads it, and file_metadata in particular
 * is document detail this list has no reason to hand to a browser.
 */
export interface ContractListRow
  extends Pick<
    ContractRow,
    | "id"
    | "contract_no"
    | "contract_amount"
    | "status"
    | "party_a_name"
    | "contract_date"
    | "sales_id"
    | "lead_id"
    | "created_at"
    | "first_payment_status"
    | "first_payment_due_date"
  > {
  leads: { customer_name: string | null } | null
  profiles: { full_name: string | null; email: string | null } | null
  installment_plans: ContractListInstallment[] | null
}

/** The whole response of GET /api/contracts/list. */
export interface ContractListResponse {
  contracts: ContractListRow[]
  role: string | null
  totalCount: number
}
