export async function POST() {
  return Response.json(
    { error: "impersonation_endpoint_retired" },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
