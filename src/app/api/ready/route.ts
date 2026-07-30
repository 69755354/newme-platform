// RBAC: internal-readiness
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const noStoreHeaders = { "Cache-Control": "no-store, max-age=0" };
const exactReleaseSha = /^[0-9a-f]{40}$/;

function stagingReleaseMetadata() {
  if (process.env.NEWME_RELEASE_METADATA_REQUIRED !== "1") return null;
  const releaseSha = process.env.NEWME_RELEASE_SHA || "";
  const buildId = process.env.NEWME_BUILD_ID || "";
  if (
    !exactReleaseSha.test(releaseSha)
    || !exactReleaseSha.test(buildId)
    || releaseSha !== buildId
  ) return false;
  return { release_sha: releaseSha, build_id: buildId };
}

export async function GET(request: NextRequest) {
  const token = process.env.NEWME_READINESS_TOKEN;
  if (!token || request.headers.get("x-newme-readiness-token") !== token) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401, headers: noStoreHeaders });
  }
  const releaseMetadata = stagingReleaseMetadata();
  if (releaseMetadata === false) {
    return NextResponse.json({ status: "degraded" }, { status: 503, headers: noStoreHeaders });
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ status: "degraded" }, { status: 503, headers: noStoreHeaders });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url + "/rest/v1/profiles?select=id&limit=1", { headers: { apikey: key, Authorization: "Bearer " + key }, signal: controller.signal, cache: "no-store" });
    return NextResponse.json(
      {
        status: response.ok ? "ready" : "degraded",
        ...(releaseMetadata || {}),
      },
      { status: response.ok ? 200 : 503, headers: noStoreHeaders },
    );
  } catch { return NextResponse.json({ status: "degraded" }, { status: 503, headers: noStoreHeaders }); }
  finally { clearTimeout(timer); }
}
