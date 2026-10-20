import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response(405, { error: "Method not allowed" });

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return response(500, { error: "Function secrets are not configured" });

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return response(401, { error: "Authentication required" });

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) return response(401, { error: "Invalid session" });

  const { data: callerProfile, error: profileError } = await caller
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .single();
  if (profileError || callerProfile?.role !== "staff") return response(403, { error: "Staff access required" });

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }
  const fullName = typeof input.full_name === "string" ? input.full_name.trim() : "";
  const studentId = typeof input.student_id === "string" ? input.student_id.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const programId = typeof input.program_id === "string" ? input.program_id : "";
  if (!fullName || fullName.length > 120 || !studentId || studentId.length > 40 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(programId)) {
    return response(400, { error: "Enter a valid name, student ID, email, password, and program" });
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: program, error: programError } = await admin
    .from("scholarship_programs")
    .select("id")
    .eq("id", programId)
    .maybeSingle();
  if (programError || !program) return response(400, { error: "Scholarship program not found" });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, student_id: studentId },
  });
  if (createError || !created.user) return response(400, { error: createError?.message ?? "Could not create account" });

  const { error: assignmentError } = await admin.from("scholar_assignments").upsert({
    scholar_id: created.user.id,
    program_id: programId,
    assigned_by: authData.user.id,
  }, { onConflict: "scholar_id" });
  if (assignmentError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return response(400, { error: assignmentError.message });
  }

  return response(201, { id: created.user.id, message: "Scholar created and assigned" });
});
