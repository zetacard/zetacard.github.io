// ZetaCard AI assistant for meeting notes and business-card data extraction.
// Deploy with Supabase CLI and configure OPENAI_API_KEY as a server secret.
// Optional: set OPENAI_MODEL. Never place provider keys in index.html.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const openAiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase function environment is incomplete" }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Sign-in is required" }, 401);
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401);
  if (!openAiKey) return json({ error: "AI provider is not configured. Set OPENAI_API_KEY as a Supabase secret." }, 503);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }
  const task = typeof body.task === "string" ? body.task : "";
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 20000) : "";
  const title = typeof body.title === "string" ? body.title.slice(0, 180) : "Meeting";
  const contact = typeof body.contact === "string" ? body.contact.slice(0, 160) : "";
  const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl : "";
  const audioDataUrl = typeof body.audioDataUrl === "string" ? body.audioDataUrl : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 160) : "meeting-audio";
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-5-mini";
  if (!["summarize", "followup", "extract_contact", "transcribe"].includes(task)) return json({ error: "Unsupported task" }, 400);
  if (!serviceRoleKey) return json({ error: "AI usage protection is not configured. Check the Supabase function environment." }, 503);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const now = Date.now();
  const hourCutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const dayCutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  try {
    const [hourCount, dayCount] = await Promise.all([
      admin.from("zc_suite_ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userData.user.id).gte("created_at", hourCutoff),
      admin.from("zc_suite_ai_usage").select("id", { count: "exact", head: true }).eq("user_id", userData.user.id).gte("created_at", dayCutoff),
    ]);
    if (hourCount.error || dayCount.error) return json({ error: "AI usage protection is unavailable. Apply the Networking Suite migration first." }, 503);
    if ((hourCount.count ?? 0) >= 8 || (dayCount.count ?? 0) >= 30) return json({ error: "AI usage limit reached (8 requests/hour and 30/day). Try again later." }, 429);
    const tracked = await admin.from("zc_suite_ai_usage").insert({ user_id: userData.user.id, task });
    if (tracked.error) return json({ error: "AI usage protection could not record this request. Try again later." }, 503);
  } catch {
    return json({ error: "AI usage protection is unavailable. Apply the Networking Suite migration first." }, 503);
  }

  let instructions = "";
  let input: unknown;
  if (task === "transcribe") {
    if (!/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/i.test(audioDataUrl) || audioDataUrl.length > 8_500_000) {
      return json({ error: "Provide a supported audio data URL up to 6 MB" }, 400);
    }
    const mime = audioDataUrl.match(/^data:(audio\/[a-z0-9.+-]+);base64,/i)?.[1] ?? "";
    const allowedMime = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg"]);
    if (!allowedMime.has(mime.toLowerCase())) return json({ error: "Use MP3, M4A/MP4, WAV, WebM or OGG audio" }, 400);
    const encoded = audioDataUrl.slice(audioDataUrl.indexOf(",") + 1);
    let binary: string;
    try { binary = atob(encoded); } catch { return json({ error: "Invalid audio encoding" }, 400); }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const extension = mime.toLowerCase().includes("webm") ? "webm" : mime.toLowerCase().includes("wav") ? "wav" : mime.toLowerCase().includes("ogg") ? "ogg" : mime.toLowerCase().includes("m4a") || mime.toLowerCase().includes("mp4") ? "m4a" : "mp3";
    const form = new FormData();
    form.set("model", Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-mini-transcribe");
    form.set("response_format", "json");
    form.set("file", new File([bytes], `${fileName.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 100) || "meeting-audio"}.${extension}`, { type: mime }));
    try {
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${openAiKey}` }, body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json({ error: result?.error?.message || "Audio transcription failed" }, 502);
      const text = typeof result.text === "string" ? result.text : "";
      if (!text.trim()) return json({ error: "No speech transcript was returned" }, 502);
      return json({ text: text.slice(0, 20000), task: "transcribe" });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Audio transcription is unavailable" }, 502);
    }
  } else if (task === "summarize" || task === "followup") {
    if (!notes.trim()) return json({ error: "Meeting notes are required" }, 400);
    instructions = task === "summarize"
      ? "You are a careful meeting-notes assistant. Summarize only information present in the supplied notes. Use sections: Summary, Decisions, Action items (include owner/due date only if explicit), Open questions. Do not invent facts or dates. If details are missing, say so."
      : "Draft a brief, polite professional follow-up email based only on the supplied notes. Do not invent promises, dates, prices, or commitments. Include a subject line and an editable draft; use placeholders where data is missing.";

