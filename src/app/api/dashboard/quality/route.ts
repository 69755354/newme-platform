// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

type CountResult = {
  count: number | null;
  error: { message: string } | null;
};

const asCountQuery = (query: unknown) => query as PromiseLike<CountResult>;

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const periodParam = request.nextUrl.searchParams.get("period");
  const periodMatch = periodParam?.match(PERIOD_PATTERN) ?? null;

  if (periodParam !== null && !periodMatch) {
    return NextResponse.json(
      { error: "Invalid period. Expected YYYY-MM." },
      { status: 400 },
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = profile?.role ?? "sales";
  const isCEO = role === "admin" || role === "boss" || role === "operator";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const period = periodMatch
    ? {
        start: new Date(
          Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]) - 1, 1),
        ).toISOString(),
        end: new Date(
          Date.UTC(Number(periodMatch[1]), Number(periodMatch[2]), 1),
        ).toISOString(),
      }
    : null;

  let totalQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false);
  let contactedQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .or("followup_count.gt.0,last_contact_date.not.is.null");
  let firstContactQuery = supabase
    .from("lead_milestones")
    .select("lead_id,leads!inner(id)", { count: "exact", head: true })
    .eq("milestone_key", "first_contact")
    .not("completed_at", "is", null)
    .eq("leads.archived", false);
  let missingFirstContactQuery = supabase
    .from("leads")
    .select("id,lead_milestones!left(id)", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .eq("lead_milestones.milestone_key", "first_contact")
    .not("lead_milestones.completed_at", "is", null)
    .is("lead_milestones", null);
  let noAnswerQuery = supabase
    .from("follow_up_logs")
    .select("id,leads!inner(id)", { count: "exact", head: true })
    .eq("no_answer", true)
    .eq("leads.archived", false);
  let followUpMissingQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .eq("followup_count", 0)
    .is("last_contact_date", null);
  let overdueFollowUpQuery = supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("archived", false)
    .is("final_status", null)
    .or(
      `next_followup_date.lt.${today},and(last_contact_date.is.null,created_at.lt.${twoDaysAgo})`,
    );

  const qualityQuery = (quality: "pending" | "good" | "normal") => {
    let query = supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("archived", false)
      .eq("quality", quality);
    if (!isCEO) query = query.eq("assigned_to", user.id);
    return query;
  };

  if (!isCEO) {
    totalQuery = totalQuery.eq("assigned_to", user.id);
    contactedQuery = contactedQuery.eq("assigned_to", user.id);
    firstContactQuery = firstContactQuery.eq("leads.assigned_to", user.id);
    missingFirstContactQuery = missingFirstContactQuery.eq("assigned_to", user.id);
    noAnswerQuery = noAnswerQuery.eq("leads.assigned_to", user.id);
    followUpMissingQuery = followUpMissingQuery.eq("assigned_to", user.id);
    overdueFollowUpQuery = overdueFollowUpQuery.eq("assigned_to", user.id);
  }

  if (period) {
    noAnswerQuery = noAnswerQuery
      .gte("created_at", period.start)
      .lt("created_at", period.end);
  }

  const results = await Promise.all([
    asCountQuery(totalQuery),
    asCountQuery(contactedQuery),
    asCountQuery(firstContactQuery),
    asCountQuery(missingFirstContactQuery),
    asCountQuery(noAnswerQuery),
    asCountQuery(followUpMissingQuery),
    asCountQuery(overdueFollowUpQuery),
    asCountQuery(qualityQuery("pending")),
    asCountQuery(qualityQuery("good")),
    asCountQuery(qualityQuery("normal")),
  ]);

  const queryError = results.find((result) => result.error)?.error;
  if (queryError) {
    console.error("Quality dashboard API error:", queryError.message);
    return NextResponse.json(
      { error: "Failed to fetch quality metrics" },
      { status: 500 },
    );
  }

  const counts = results.map((result) => result.count ?? 0);
  const [
    totalLeads,
    contactedLeads,
    firstContactDone,
    missingFirstContact,
    noAnswerCount,
    followUpMissing,
    ovvу~mўG§ІЪоќЖ­yШИ]N€XYЛ\њ›ЬЋ€XYС\њ€HH]ШZ]XYФ]Y\ћNВ€Y€
XYС\њЉHВ€ЫЫњЫЫK™\њ›ЬЉ–Ь\[[™KYќ[›™[HZ[YИ™]ЪXYО€‹XYС\њЉNВ€™]\›€™^™\ЬЫњЩKљњЫЫЉИ\њ›ЬЋ€‘Z[YИ™]ЪXYИ€KИЭ]\О€LJNВ€B‚€ЫЫњЭЭ[XYИHXYПЛ›[™ЭВ‚€ЛИ8Ґ 8Ґ 8Ґ Э\Ћ€ќZ[ЭYЩHЫЭ[ќИ8Ґ 8Ґ 8Ґ €ЫЫњЭЭYЩPЫЭ[ќX\€™XЫЬ™Эљ[™Лќ[X™\Џ€HЯNВ€ЫЫњЭЭYЩSXYО€™XЫЬ™Эљ[™Л[ћVЧO€HЯNВ€›Ь€
ЫЫњЭY€Щ€ХQСWСQ”КHВ€ЭYЩPЫЭ[ќX\ЩY‹љЩ^WHHВ€ЭYЩSXYЦЩY‹љЩ^WHHЧNВ€B‚€›Ь€
ЫЫњЭЩ€XYИЧJHВ€ЫЫњЭИH™љ[[ЬЭ]\И›Ь›X[^™SZ[\ЭЫ™JЭ\њ™[ќЫZ[\ЭЫ™H›™]ИЉNВ€Y€
ЭYЩPЫЭ[ќX\ЬЧHOOH[™Yљ[™Y
HВ€ЭYЩPЫЭ[ќX\ЬЧJКОВ€ЭYЩSXYЦЬЧKњ\Ъ

NВ€B€B‚€ЛИ8Ґ 8Ґ 8Ґ Э\О€Ш[Э[]H]™\YЩH^\И[€ЭYЩH8Ґ 8Ґ 8Ґ €ЛИ›Ь€XXЪЭYЩKЩHЫЪИ]XYИХT”‘S•H[€]ЭYЩH[™Ш[Э[]B€ЛИЭИЫ™И^IЭ™H™Y[€\™H
^\ИЪ[ЩH\]YШ]Ь€Ь™X]YШ]
K‚€ЛИ›Ь€ќЫЫ€‹И›ЬЭ€ЩHЫЪИ]XYИ]™XXЪY]Э]ЫЫYK‚€ќ[Э[Ы€Ш[Р]™С^\Т[”ЭYЩJЭYЩRЩ^N€Эљ[™ЛXYТ[”ЭYЩN€[ћVЧJN€ќ[X™\€В€Y€
XYТ[”ЭYЩK›[™ЭOOH
H™]\›€В€ЫЫњЭ›ЭИH™]И]J
K™Щ][YJ
NВ€]Э[^\ИHВ€]ЫЭ[ќHВ€›Ь€
ЫЫњЭЩ€XYТ[”ЭYЩJHВ€ЫЫњЭ™Y‘]HHќ\]YШ]Ь™X]YШ]В€Y€
\™Y‘]JHЫЫќ[ќYNВ€ЫЫњЭ^\ИH
›ЭИH™]И]J™Y‘]JK™Щ][YJ
JHИ—НМВ€Э[^\И
ПH^\ОВ€ЫЭ[ќ
КОВ€B€™]\›€ЫЭ[ќ€ИX]њ›Э[™

Э[^\ИИЫЭ[ќ
H
€L
HИL€В€B‚€ЛИ8Ґ 8Ґ 8Ґ Э\€ќZ[ќ[›™[ЭYЩ\ИЪ]Y]љXЬИ8Ґ 8Ґ 8Ґ €ЫЫњЭЬЫЭ[ќHЭYЩPЫЭ[ќX\ФХQСWСQ”ЦМKљЩ^WHNИЛИ›™]И€\ИЬ‚€ЫЫњЭЭYЩ\ИHХQСWСQ”Л›X\

Y‹Y
HO€В€ЫЫњЭЫЭ[ќHЭYЩPЫЭ[ќX\ЩY‹љЩ^WHВ€ЫЫњЭЭЩ•ЬHЬЫЭ[ќ€ИX]њ›Э[™

ЫЭ[ќИЬЫЭ[ќ
H
€L
H€В€ЫЫњЭ]™С^\Т[”ЭYЩHHШ[Р]™С^\Т[”ЭYЩJY‹љЩ^KЭYЩSXYЦЩY‹љЩ^WJNВ‚€ЛИЫЫќ™\њЪ[Ы€]HИ™^ЭYЩB€ЫЫњЭ™^Y€HХQСWСQ”ЦЪY
ИWNВ€]ЫЫќ™\њЪ[Ы•У™^€ќ[X™\€ќ[Hќ[В€Y€
™^Y€	‰€Y‹љЩ^HOOH›ЬЭ€	‰€Y‹љЩ^HOOHќЫЫ€ЉHВ€ЫЫњЭ™^ЫЭ[ќHЭYЩPЫЭ[ќX\Ы™^Y‹љЩ^WHВ€ЫЫќ™\њЪ[Ы•У™^HЫЭ[ќ€ИX]њ›Э[™

™^ЫЭ[ќИЫЭ[ќ
H
€L
H€В€B‚€ЛИ›Э[™XЪО€ЫЫќ™\њЪ[Ы€М	HИ™^ЭYЩH
Ы›H›Ь€\[[™HЭYЩ\Л›ЭЫЫ‹ЫЬЭ
B€ЫЫњЭ\Р›Э[™XЪИHЫЫќ™\њЪ[Ы•У™^OOHќ[	‰€ЫЫќ™\њЪ[Ы•У™^М	‰€ЫЭ[ќ€И	‰€Y‹љЩ^HOOHќЫЫ€€	‰€Y‹љЩ^HOOH›ЬЭЋВ‚€™]\›€В€Щ^N€Y‹љЩ^K€X™[€Y‹›X™[€ЫЭ[ќ€ЭЩ•Ь€ЫЫќ™\њЪ[Ы•У™^€]™С^\Т[”ЭYЩK€\Р›Э[™XЪЛ€NВ€JNВ‚€ЛИ8Ґ 8Ґ 8Ґ Э\N€ЭXЪИXYИ8 %[€HЭYЩH›Ь€€ћ]™\YЩH\][Ы€8Ґ 8Ґ 8Ґ €ЫЫњЭЭXЪУXYО€ИY€Эљ[™ОИЭ\ЭЫY\—Ы[YN€Эљ[™Иќ[ИЭYЩN€Эљ[™ОИ^\ЧЪ[—ЬЭYЩN€ќ[X™\ЋИЭYЩWЫX™[€Эљ[™ИVЧHHЧNВ€ЫЫњЭ›ЭИH™]И]J
K™Щ][YJ
NВ€›Ь€
ЫЫњЭY€Щ€ХQСWСQ”КHВ€Y€
Y‹љЩ^HOOHќЫЫ€€Y‹љЩ^HOOH›ЬЭЉHЫЫќ[ќYNВ€ЫЫњЭ]™С^\ИHЭYЩ\Л™љ[™
ИO€ЛљЩ^HOOHY‹љЩ^JOЛ]™С^\Т[”ЭYЩHNВ€ЫЫњЭ™\ЪЫH]™С^\И
€ЋВ€Y€
™\ЪЫH
HЫЫќ[ќYNВ‚€›Ь€
ЫЫњЭЩ€ЭYЩSXYЦЩY‹љЩ^WHЧJHВ€ЫЫњЭ™Y‘]HHќ\]YШ]Ь™X]YШ]В€Y€
\™Y‘]JHЫЫќ[ќYNВ€ЫЫњЭ^\Т[”ЭYЩHH
›ЭИH™]И]J™Y‘]JK™Щ][YJ
JHИ—НМВ€Y€
^\Т[”ЭYЩH€™\ЪЫ
HВ€ЭXЪУXYЛњ\Ъ
В€Y€љY€Э\ЭЫY\—Ы[YN€Э\ЭЫY\—Ы[YK€ЭYЩN€њЭYЩK€^\ЧЪ[—ЬЭYЩN€X]њ›Э[™
^\Т[”ЭYЩJK€ЭYЩWЫX™[€Y‹›X™[€JNВ€B€B€B‚€ЛИЫЬќЭXЪИXYИћH^\ЧЪ[—ЬЭYЩH\ШВ€ЭXЪУXYЛњЫЬќ

KЉHO€‹™^\ЧЪ[—ЬЭYЩHHK™^\ЧЪ[—ЬЭYЩJNВ‚€ЛИ8Ґ 8Ґ 8Ґ Э\Ћ€•Ъ\™HHЬЩH[ЬЭ€8 %›Ь€Ш[\ИљY]Лљ[™HЭYЩHЪ]H[ЬЭXYИЬЭ8Ґ 8Ґ 8Ґ €ЫЫњЭЬЭЭYЩHHЭYЩ\Л™љ[™
ИO€ЛљЩ^HOOH›ЬЭЉNВ€ЫЫњЭЬЭЫЭ[ќHЬЭЭYЩOЛЫЭ[ќВ€ЫЫњЭЬЭњ›ЫTЭYЩN€™XЫЬ™Эљ[™Лќ[X™\Џ€HЯNВ€ЛИЫЪИ]ќ\Ъ[™\ЬЧЩ]™[ќИ›Ь€ЭYЩWШЪ[™ЩH]™[ќИ][™Y[€ЬЭ€]]™[ќФ]Y\ћHHЭ\X\ЩB€™њ›ЫJќ\Ъ[™\ЬЧЩ]™[ќИЉB€њЩ[XЭ
™]™[ќЩ]HЉB€™\J™]™[ќЭ\H‹њЭYЩWШЪ[™ЩHЉNВ€Y€
Z\УX[YЩ[Y[ќ
HВ€]™[ќФ]Y\ћHH]™[ќФ]Y\ћK™\J›XYЪY‹Э\X\ЩKњњК™Щ]Э\Щ\—ЫXYЧЪYИ‹ИЭ\Щ\—ЪY€\™Щ]\Щ\’YJJNВ€B€ЫЫњЭИ]N€]™[ќИHH]ШZ]]™[ќФ]Y\ћK›[Z]
L
NВ€Y€
]™[ќКHВ€›Ь€
ЫЫњЭ]ќЩ€]™[ќКHВ€ЫЫњЭ]HH]ќ™]™[ќЩ]H\И[ћNВ€Y€
]OЛќЧЬЭYЩHOOH›ЬЭ€	‰€]OЛ™њ›ЫWЬЭYЩJHВ€ЬЭњ›ЫTЭYЩVЩ]K™њ›ЫWЬЭYЩWHH
ЬЭњ›ЫTЭYЩVЩ]K™њ›ЫWЬЭYЩWH
H
ИNВ€B€B€B‚€™]\›€™^™\ЬЫњЩKљњЫЫЉВ€ЭYЩ\Л€ЭXЪУXYЛ€Э[XYЛ€ЬЭњ›ЫTЭYЩK€JNВ€HШ]Ъ
\њЋ€[ћJHВ€ЫЫњЭY\ЬШYЩHH›ШЩ\ЬЛ™[ќ‹““СWСS•€OOHњ›ЩXЭ[Ы€€И’[ќ\›[Щ\ќ™\€\њ›Ь€€€\њ‹›Y\ЬШYЩNВ€ЫЫњЫЫK™\њ›ЬЉ–Ь\[[™KYќ[›™[H\њ›ЬЋ€‹\њЉNВ€™]\›€™^™\ЬЫњЩKљњЫЫЉИ\њ›ЬЋ€Y\ЬШYЩHKИЭ]\О€LJNВ€BџB