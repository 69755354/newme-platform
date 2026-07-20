import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const hdr = request.headers.get("authorization") || "NONE";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7, 27) + "..." : hdr.slice(0, 20);
  return NextResponse.json({
    hotfix: 4,
    token: token,
    env_url: process.env.NEXT_PUBLIC_SUPABASE_URL?.slice(0, 30) || "MISSING",
    env_key: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 8) || "MISSING",
    env_anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.slice(0, 8) || "MISSING",
  });
}
