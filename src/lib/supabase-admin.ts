import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _instance: SupabaseClient | undefined;

function getSupabaseAdmin(): SupabaseClient {
  if (_instance) return _instance;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "supabaseAdmin: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required at runtime"
    );
  }
  _instance = createClient(url, key);
  return _instance;
}

// Proxy defers createClient() to first property access at request time.
// Module import no longer triggers build-time env-var evaluation.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getSupabaseAdmin(), prop, receiver);
  },
});
