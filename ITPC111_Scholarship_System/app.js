(() => {
  const cfg = window.APP_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
  const $ = (id) => document.getElementById(id);
  let sb = null,
    session = null,
    profile = null,
    currentView = "dashboard",
    selectedSemester = "all",
    cache = { submissions: [], programs: [], scholars: [], assignments: [], logs: [], profileNames: {} };
  const escapeHtml = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const dateFmt = (s) =>
    s
      ? new Date(s).toLocaleString("en-PH", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";
  const pill = (v) => {
    const s = String(v || "Pending");
    let c = "";
    if (["Verified", "Compliant", "Approved"].includes(s)) c = "good";
    else if (["Returned", "With Deficiency", "Held"].includes(s)) c = "bad";
    else if (["Pending", "Not Evaluated"].includes(s)) c = "warn";
    return `<span class="pill ${c}">${escapeHtml(s)}</span>`;
  };
  function toast(msg) {
    $("toast").textContent = msg;
    $("toast").classList.remove("hidden");
    setTimeout(() => $("toast").classList.add("hidden"), 4200);
  }
  function authMessage(msg, ok = false) {
    $("auth-message").textContent = msg;
    $("auth-message").classList.toggle("success", ok);
  }
  function showAuthTab(tab) {
    $("login-form").classList.toggle("hidden", tab !== "login");
    $("signup-form").classList.toggle("hidden", tab !== "signup");
    $("login-tab").classList.toggle("active", tab === "login");
    $("signup-tab").classList.toggle("active", tab === "signup");
    authMessage("");
  }
  $("login-tab").addEventListener("click", () => showAuthTab("login"));
  $("signup-tab").addEventListener("click", () => showAuthTab("signup"));
  function setupWarning() {
    if (!configured) {
      $("setup-alert").classList.remove("hidden");
      $("setup-alert").innerHTML =
        'Supabase is not configured yet. Open <span class="setup-code">config.js</span> and add your project URL and publishable/anon key. Then run the SQL in <span class="setup-code">supabase/schema.sql</span>. This app intentionally does not contain a service-role key.';
      $("connection-label").textContent = "Setup required";
      return true;
    }
    return false;
  }
  async function init() {
    if (setupWarning()) return;
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    $("connection-label").textContent = "Supabase ready";
    const { data, error } = await sb.auth.getSession();
    if (error) {
      toast(error.message);
      return;
    }
    session = data.session;
    if (session) await enterApp();
    sb.auth.onAuthStateChange((_event, s) => {
      session = s;
      setTimeout(() => (s ? enterApp() : showLoggedOut()), 0);
    });
  }
  async function signUp(e) {
    e.preventDefault();
    if (!sb) return;
    const full_name = $("signup-name").value.trim(),
      student_id = $("signup-student-id").value.trim(),
      email = $("signup-email").value.trim(),
      password = $("signup-password").value;
    if (!full_name || !student_id) {
      authMessage("Enter your name and student ID.");
      return;
    }
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { full_name, student_id } },
    });
    if (error) {
      authMessage(error.message);
      return;
    }
    authMessage(
      data.session
        ? "Account created. Signing you in…"
        : "Account created. Check your email to confirm it, then sign in.",
      true,
    );
    if (data.session) {
      session = data.session;
      await enterApp();
    }
  }
  async function signIn(e) {
    e.preventDefault();
    if (!sb) return;
    const { data, error } = await sb.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    if (error) {
      authMessage(error.message);
      return;
    }
    session = data.session;
    await enterApp();
  }
  async function signOut() {
    if (sb) await sb.auth.signOut();
    session = null;
    profile = null;
    showLoggedOut();
  }
  $("signup-form").addEventListener("submit", signUp);
  $("login-form").addEventListener("submit", signIn);
  $("signout-btn").addEventListener("click", signOut);
  function showLoggedOut() {
    $("auth-view").classList.remove("hidden");
    $("app-view").classList.add("hidden");
    $("nav").classList.add("hidden");
    $("signout-btn").classList.add("hidden");
    $("user-chip").classList.add("hidden");
    $("page-title").textContent = "Welcome";
  }
  async function enterApp() {
    if (!session || !sb) return;
    const { data, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .maybeSingle();
    if (error) {
      toast("Could not load profile: " + error.message);
      return;
    }
    if (!data) {
      $("setup-alert").classList.remove("hidden");
      $("setup-alert").textContent =
        "Your authentication account has no profile yet. Apply the profile trigger from schema.sql, then sign out and sign in again.";
      return;
    }
    profile = data;
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("nav").classList.remove("hidden");
    $("signout-btn").classList.remove("hidden");
    $("user-chip").classList.remove("hidden");
    $("user-chip").textContent = profile.full_name || session.user.email;
    $("connection-label").textContent =
      profile.role === "staff" ? "Staff workspace" : "Scholar workspace";
    document
      .querySelectorAll(".staff-only")
      .forEach((el) => el.classList.toggle("hidden", profile.role !== "staff"));
    await loadData();
    render();
  }
  async function loadData() {
    const tasks = [
      sb.from("scholarship_programs").select("*").order("name"),
      sb
        .from("submissions")
        .select(
          "*, profiles:scholar_id(id,full_name,student_id)",
        )
        .order("submitted_at", { ascending: false }),
      sb
        .from("scholar_assignments")
        .select(
          "scholar_id, program_id, programs:program_id(name,max_gwa,min_units,max_failed,max_incomplete,max_dropped,deadline)",
        ),
      profile.role === "staff"
        ? sb.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100)
        : Promise.resolve({ data: [], error: null }),
    ];
    const [p, s, a, l] = await Promise.all(tasks);
    if (p.error) toast("Programs: " + p.error.message);
    if (s.error) toast("Submissions: " + s.error.message);
    if (a.error) toast("Assignments: " + a.error.message);
    if (l.error) toast("History: " + l.error.message);
    cache.programs = p.data || [];
    cache.assignments = a.data || [];
    const assignments = new Map(
      cache.assignments.map((assignment) => [assignment.scholar_id, assignment]),
    );
    cache.submissions = (s.data || []).map((submission) => ({
      ...submission,
      assignments: assignments.get(submission.scholar_id) || null,
    }));
    cache.logs = profile.role === "staff" ? l.data || [] : [];
    if (profile.role === "staff") {
      const r = await sb
        .from("profiles")
        .select("id,full_name,student_id,role,created_at")
        .order("full_name");
      cache.profileNames = Object.fromEntries(
        (r.data || []).map((person) => [person.id, person.full_name]),
      );
      cache.scholars = (r.data || [])
        .filter((person) => person.role === "scholar")
        .map((scholar) => ({
          ...scholar,
          assignment: assignments.get(scholar.id) || null,
        }));
    }
  }
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      currentView = b.dataset.view;
      document
        .querySelectorAll("[data-view]")
        .forEach((x) => x.classList.toggle("active", x === b));
      render();
    }),
  );
  function render() {
    const title = {
      dashboard: "Dashboard",
      submissions: "Semester submissions",
      scholars: "Scholar management",
      programs: "Programs & policies",
      history: "Audit history",
    };
    $("page-title").textContent = title[currentView] || "Dashboard";
    renderStats();
    const c = $("content");
    if (currentView === "dashboard") c.innerHTML = dashboardHtml();
    else if (currentView === "submissions") c.innerHTML = submissionsHtml();
    else if (currentView === "scholars") c.innerHTML = scholarsHtml();
    else if (currentView === "programs") c.innerHTML = programsHtml();
    else c.innerHTML = historyHtml();
    bindContent();
  }
  function semesterItems() {
    return [
      ...new Set(
        cache.submissions.map((s) => `${s.academic_year}|${s.semester}`),
      ),
    ]
      .sort()
      .reverse();
  }
  function renderStats() {
    const all = cache.submissions;
    const shown = all.filter((s) =>
      (profile.role === "staff" || s.scholar_id === profile.id) &&
      (selectedSemester === "all" || `${s.academic_year}|${s.semester}` === selectedSemester),
    );
    const items = [
      [
        "Assigned scholars",
        profile.role === "staff" ? cache.assignments.length : (cache.assignments.length ? 1 : 0),
        selectedSemester === "all" ? "Current scholar assignments" : "Assigned scholars",
      ],
      [
        "Pending verification",
        shown.filter((s) => s.verification_status === "Pending").length,
        "Awaiting staff review",
      ],
      [
        "Compliant",
        shown.filter((s) => s.compliance_status === "Compliant").length,
        "Verified and all checks passed",
      ],
      [
        "With deficiency",
        shown.filter((s) => s.compliance_status === "With Deficiency").length,
        "Review required",
      ],
    ];
    $("stats").innerHTML = items
      .map(
        (x) =>
          `<div class="stat-card"><div class="stat-label">${x[0]}</div><div class="stat-number">${x[1]}</div><div class="stat-note">${x[2]}</div></div>`,
      )
      .join("");
  }
  function dashboardHtml() {
    const mine = cache.submissions
      .filter((s) => profile.role === "staff" || s.scholar_id === profile.id)
      .slice(0, 6);
    const assignment = cache.assignments.find((item) => item.scholar_id === profile.id);
    const program = assignment?.programs;
    const scholarship = profile.role === "scholar"
      ? `<div class="panel"><div class="section-head"><div><h2>My scholarship</h2><p>${escapeHtml(program?.name || "No program assigned")}</p></div></div>${program ? `<div class="detail-grid"><div class="detail"><small>Maximum GWA</small><strong>${Number(program.max_gwa).toFixed(2)}</strong></div><div class="detail"><small>Minimum units</small><strong>${program.min_units}</strong></div><div class="detail"><small>Maximum failed</small><strong>${program.max_failed}</strong></div><div class="detail"><small>Maximum incomplete</small><strong>${program.max_incomplete}</strong></div><div class="detail"><small>Maximum dropped</small><strong>${program.max_dropped}</strong></div><div class="detail"><small>Submission deadline</small><strong>${dateFmt(program.deadline)}</strong></div></div>` : '<p class="muted">Contact scholarship staff to receive an assignment.</p>'}</div>`
      : "";
    return `${scholarship}<div class="section-head"><div><h2>Overview</h2><p>${profile.role === "staff" ? "Monitor scholar submissions and renewal readiness." : "Track your latest academic submissions and decisions."}</p></div><div class="toolbar dashboard-tools"><label for="dashboard-semester">Semester</label><select id="dashboard-semester"><option value="all">All semesters</option>${semesterItems().map((value) => { const [year, semester] = value.split("|"); return `<option value="${escapeHtml(value)}" ${selectedSemester === value ? "selected" : ""}>${escapeHtml(year)} · Semester ${semester}</option>`; }).join("")}</select>${profile.role === "scholar" ? '<button class="btn btn-primary" data-action="new-submission">＋ Submit grades</button>' : '<button class="btn btn-primary" data-view="scholars">＋ Register / assign scholar</button>'}</div></div><div class="panel"><div class="section-head"><div><h2>Recent submissions</h2><p>Latest semester activity</p></div><button class="btn btn-ghost btn-small" data-view="submissions">View all</button></div>${tableHtml(mine)}</div><div class="notice">Remember: verification status, academic compliance, and renewal decision are separate. A verified record may still have deficiencies, and deficient records cannot be approved.</div>`;
  }
  function tableHtml(rows) {
    if (!rows.length)
      return '<div class="empty">No submissions found yet.</div>';
    return `<div class="table-wrap"><table><thead><tr>${profile.role === "staff" ? "<th>Scholar</th>" : ""}<th>Semester</th><th>Program</th><th>GWA</th><th>Verification</th><th>Compliance</th><th>Renewal</th><th>Action</th></tr></thead><tbody>${rows.map((s) => `<tr>${profile.role === "staff" ? `<td><div class="primary-text">${escapeHtml(s.profiles?.full_name || "Scholar")}</div><div class="sub-text">${escapeHtml(s.profiles?.student_id || "")}</div></td>` : ""}<td><div class="primary-text">${escapeHtml(s.academic_year)}</div><div class="sub-text">Semester ${s.semester}</div></td><td>${escapeHtml(s.assignments?.programs?.name || "—")}</td><td>${Number(s.gwa).toFixed(2)}</td><td>${pill(s.verification_status)}</td><td>${pill(s.compliance_status)}</td><td>${pill(s.renewal_decision)}</td><td><button class="btn btn-ghost btn-small" data-action="details" data-id="${s.id}">Details</button>${profile.role === "staff" && s.verification_status !== "Verified" ? ` <button class="btn btn-primary btn-small" data-action="verify" data-id="${s.id}">Review</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function submissionsHtml() {
    return `<div class="section-head"><div><h2>All submissions</h2><p>Search records and filter by semester, program, and workflow status.</p></div>${profile.role === "scholar" ? '<button class="btn btn-primary" data-action="new-submission">＋ Submit grades</button>' : ""}</div><div class="panel"><div class="toolbar"><input id="search-submissions" placeholder="Search student ID or name"><select id="filter-semester"><option value="">All semesters</option>${semesterItems().map((value) => { const [year, semester] = value.split("|"); return `<option value="${escapeHtml(value)}">${escapeHtml(year)} · Semester ${semester}</option>`; }).join("")}</select><select id="filter-program"><option value="">All programs</option>${cache.programs.map((p) => `<option>${escapeHtml(p.name)}</option>`).join("")}</select><select id="filter-verification"><option value="">All verification statuses</option><option>Pending</option><option>Verified</option><option>Returned</option></select><select id="filter-compliance"><option value="">All compliance statuses</option><option>Not Evaluated</option><option>Compliant</option><option>With Deficiency</option></select></div><div id="submission-table">${tableHtml(cache.submissions.filter((s) => profile.role === "staff" || s.scholar_id === profile.id))}</div></div>`;
  }
  function scholarsHtml() {
    if (profile.role !== "staff")
      return '<div class="panel empty">Staff access required.</div>';
    return `<div class="section-head"><div><h2>Scholar assignments</h2><p>Register scholars, then assign one of the saved policy records.</p></div><button class="btn btn-primary" data-action="register-scholar">＋ Register scholar</button></div><div class="panel"><div class="toolbar"><input id="search-scholars" placeholder="Search student ID or name"></div><div id="scholar-table">${scholarTable(cache.scholars)}</div></div><div class="notice">For security, staff accounts should be provisioned by a trusted administrator. Do not let users choose their own role.</div>`;
  }
  function programsHtml() {
    if (profile.role !== "staff")
      return '<div class="panel empty">Staff access required.</div>';
    return `<div class="section-head"><div><h2>Scholarship programs</h2><p>Manage the persisted eligibility rules and submission deadlines.</p></div><button class="btn btn-primary" data-action="edit-policy">＋ Add policy</button></div><div class="panel"><div class="table-wrap"><table><thead><tr><th>Program</th><th>Maximum GWA</th><th>Minimum units</th><th>Failed</th><th>Incomplete</th><th>Dropped</th><th>Deadline</th><th></th></tr></thead><tbody>${cache.programs.map((program) => `<tr><td class="primary-text">${escapeHtml(program.name)}</td><td>${Number(program.max_gwa).toFixed(2)}</td><td>${program.min_units}</td><td>${program.max_failed}</td><td>${program.max_incomplete}</td><td>${program.max_dropped}</td><td>${dateFmt(program.deadline)}</td><td><button class="btn btn-ghost btn-small" data-action="edit-policy" data-id="${program.id}">Edit</button></td></tr>`).join("")}</tbody></table></div></div>`;
  }
  function scholarTable(rows) {
    if (!rows.length)
      return '<div class="empty">No scholar profiles found. Register one using the button above.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Scholar</th><th>Student ID</th><th>Assignment</th><th>Action</th></tr></thead><tbody>${rows
      .map((p) => {
        const a = p.assignment?.programs?.name || "Not assigned";
        return `<tr><td class="primary-text">${escapeHtml(p.full_name)}</td><td>${escapeHtml(p.student_id || "—")}</td><td>${escapeHtml(a)}</td><td><button class="btn btn-ghost btn-small" data-action="edit-scholar" data-id="${p.id}">Edit</button> <button class="btn btn-primary btn-small" data-action="assign-scholar" data-id="${p.id}">Assign program</button></td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  }
  function historyHtml() {
    const logs = cache.logs.filter(
      (l) => profile.role === "staff" || l.scholar_id === profile.id,
    );
    if (!logs.length)
      return '<div class="panel empty">No audit events recorded yet.</div>';
    return `<div class="panel"><div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th><th>Submission</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${dateFmt(l.created_at)}</td><td>${escapeHtml(cache.profileNames[l.actor_id] || l.actor_id)}</td><td class="primary-text">${escapeHtml(l.action)}</td><td>${escapeHtml(JSON.stringify(l.details))}</td><td>${escapeHtml((l.submission_id || "").slice(0, 8))}…</td></tr>`).join("")}</tbody></table></div></div>`;
  }
  function bindContent() {
    document
      .querySelectorAll("[data-action]")
      .forEach((b) =>
        b.addEventListener("click", () =>
          action(b.dataset.action, b.dataset.id),
        ),
      );
    document.querySelectorAll("[data-view]").forEach((b) => {
      if (!b.dataset.bound) {
        b.dataset.bound = "1";
        b.addEventListener("click", () => {
          currentView = b.dataset.view;
          render();
        });
      }
    });
    const search = $("search-submissions");
    if (search) {
      const update = () => {
        const q = search.value.toLowerCase(),
          prog = $("filter-program").value,
          comp = $("filter-compliance").value,
          verification = $("filter-verification").value,
          semester = $("filter-semester").value;
        const rows = cache.submissions.filter(
          (s) =>
            (profile.role === "staff" || s.scholar_id === profile.id) &&
            `${s.profiles?.full_name || ""} ${s.profiles?.student_id || ""} ${s.academic_year}`
              .toLowerCase()
              .includes(q) &&
            (!prog || s.assignments?.programs?.name === prog) &&
            (!comp || s.compliance_status === comp) &&
            (!verification || s.verification_status === verification) &&
            (!semester || `${s.academic_year}|${s.semester}` === semester),
        );
        $("submission-table").innerHTML = tableHtml(rows);
        bindTableActions();
      };
      [search, $("filter-semester"), $("filter-program"), $("filter-verification"), $("filter-compliance")].forEach((el) =>
        el.addEventListener("input", update),
      );
    }
    const dashboardSemester = $("dashboard-semester");
    if (dashboardSemester)
      dashboardSemester.addEventListener("change", () => {
        selectedSemester = dashboardSemester.value;
        renderStats();
      });
    const ss = $("search-scholars");
    if (ss)
      ss.addEventListener("input", () => {
        $("scholar-table").innerHTML = scholarTable(
          cache.scholars.filter((p) =>
            `${p.full_name} ${p.student_id || ""}`
              .toLowerCase()
              .includes(ss.value.toLowerCase()),
          ),
        );
        bindTableActions();
      });
  }
  function bindTableActions() {
    document.querySelectorAll("[data-action]").forEach((b) => {
      if (!b.dataset.bound) {
        b.dataset.bound = "1";
        b.addEventListener("click", () =>
          action(b.dataset.action, b.dataset.id),
        );
      }
    });
  }
  function modal(html) {
    $("modal-content").innerHTML = html;
    $("modal").showModal();
  }
  async function action(name, id) {
    if (name === "new-submission") return newSubmission();
    if (name === "details") return details(id);
    if (name === "verify") return verifyModal(id);
    if (name === "correct") return correctSubmission(id);
    if (name === "register-scholar") return registerScholar();
    if (name === "assign-scholar") return assignScholar(id);
    if (name === "evaluate") return evaluate(id);
    if (name === "decision") return decision(id);
    if (name === "edit-policy") return editPolicy(id);
    if (name === "edit-scholar") return editScholar(id);
  }
  function newSubmission() {
    modal(
      `<div class="modal-body"><h3>Submit semester grades</h3><p class="muted">Enter your academic summary and a reference to the supporting grade document.</p><form id="submission-form"><div class="form-grid"><label>Academic year<input name="academic_year" required placeholder="2026-2027" pattern="20\\d{2}-20\\d{2}"></label><label>Semester<select name="semester" required><option value="1">Semester 1</option><option value="2">Semester 2</option><option value="3">Summer / Semester 3</option></select></label><label>GWA<input name="gwa" type="number" min="1" max="5" step=".01" required></label><label>Enrolled units<input name="enrolled_units" type="number" min="0" step="1" required></label><label>Failed subjects<input name="failed_count" type="number" min="0" step="1" value="0" required></label><label>Incomplete grades<input name="incomplete_count" type="number" min="0" step="1" value="0" required></label><label>Dropped subjects<input name="dropped_count" type="number" min="0" step="1" value="0" required></label><label class="wide">Grade-document reference<input name="evidence_reference" required maxlength="500" placeholder="Secure document path or reference ID"></label></div><div class="notice">A reference is stored, not the grade file itself. Do not paste public links to private student records.</div><button class="btn btn-primary full">Submit for verification</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("submission-form").addEventListener("submit", submitGrades);
  }
  async function submitGrades(e) {
    e.preventDefault();
    const f = new FormData(e.target),
      payload = {
        scholar_id: profile.id,
        academic_year: f.get("academic_year").trim(),
        semester: Number(f.get("semester")),
        gwa: Number(f.get("gwa")),
        enrolled_units: Number(f.get("enrolled_units")),
        failed_count: Number(f.get("failed_count")),
        incomplete_count: Number(f.get("incomplete_count")),
        dropped_count: Number(f.get("dropped_count")),
        evidence_reference: f.get("evidence_reference").trim(),
      };
    const { error } = await sb.rpc("submit_grades", payload);
    if (error) {
      $("modal-message").textContent = error.message;
      return;
    }
    toast("Submission received.");
    $("modal").close();
    await loadData();
    render();
  }
  function details(id) {
    const s = cache.submissions.find((x) => x.id === id);
    if (!s) return;
    const reasons = Array.isArray(s.compliance_reasons)
      ? s.compliance_reasons
      : [];
    modal(
      `<div class="modal-body"><h3>Submission details</h3><p class="muted">${escapeHtml(s.profiles?.full_name || profile.full_name)} · ${escapeHtml(s.academic_year)} Semester ${s.semester}</p><p class="muted">Submitted ${dateFmt(s.submitted_at)}</p><div class="detail-grid"><div class="detail"><small>GWA</small><strong>${Number(s.gwa).toFixed(2)}</strong></div><div class="detail"><small>Enrolled units</small><strong>${s.enrolled_units}</strong></div><div class="detail"><small>Failed subjects</small><strong>${s.failed_count}</strong></div><div class="detail"><small>Incomplete grades</small><strong>${s.incomplete_count}</strong></div><div class="detail"><small>Dropped subjects</small><strong>${s.dropped_count}</strong></div><div class="detail"><small>Program</small><strong>${escapeHtml(s.assignments?.programs?.name || "—")}</strong></div><div class="detail"><small>Verification</small><strong>${escapeHtml(s.verification_status)}</strong></div><div class="detail"><small>Compliance</small><strong>${escapeHtml(s.compliance_status)}</strong></div><div class="detail"><small>Renewal</small><strong>${escapeHtml(s.renewal_decision)}</strong></div></div><label>Evidence reference<input readonly value="${escapeHtml(s.evidence_reference)}"></label><label>Verification reason<textarea readonly>${escapeHtml(s.verification_reason || "—")}</textarea></label><label>Decision note<textarea readonly>${escapeHtml(s.decision_note || "—")}</textarea></label><h4>Compliance reasons</h4>${reasons.length ? `<ul class="reason-list">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : '<p class="muted">Not evaluated yet, or no deficiencies.</p>'}${profile.role === "staff" ? `<div class="actions"><button class="btn btn-primary" data-action="verify" data-id="${s.id}">Verification</button><button class="btn btn-ghost" data-action="evaluate" data-id="${s.id}">Evaluate</button><button class="btn btn-ghost" data-action="decision" data-id="${s.id}">Renewal decision</button></div>` : s.verification_status === "Returned" ? `<div class="actions"><button class="btn btn-primary" data-action="correct" data-id="${s.id}">Correct and resubmit</button></div>` : ""}</div>`,
    );
    bindTableActions();
  }
  function verifyModal(id) {
    const s = cache.submissions.find((x) => x.id === id);
    if (!s) return;
    modal(
      `<div class="modal-body"><h3>Verify evidence</h3><p class="muted">${escapeHtml(s.profiles?.full_name || "Scholar")} · ${escapeHtml(s.academic_year)} Semester ${s.semester}</p><p>Reference: <strong>${escapeHtml(s.evidence_reference)}</strong></p><form id="verify-form"><label>Verification outcome<select name="outcome"><option value="Verified">Verified</option><option value="Returned">Returned for correction</option></select></label><label>Reason / staff note<textarea name="reason" required placeholder="Explain verification result or correction needed"></textarea></label><button class="btn btn-primary full">Save verification</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("verify-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("verify_submission", {
        p_submission_id: id,
        p_outcome: f.get("outcome"),
        p_reason: f.get("reason").trim(),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Verification saved.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  function correctSubmission(id) {
    const s = cache.submissions.find((x) => x.id === id);
    if (!s || profile.role !== "scholar" || s.verification_status !== "Returned") return;
    modal(
      `<div class="modal-body"><h3>Correct and resubmit</h3><p class="muted">${escapeHtml(s.academic_year)} · Semester ${s.semester}</p><p class="notice">${escapeHtml(s.verification_reason || "Review the returned record and update the requested information.")}</p><form id="correction-form"><div class="form-grid"><label>GWA<input name="gwa" type="number" min="1" max="5" step=".01" value="${Number(s.gwa)}" required></label><label>Enrolled units<input name="enrolled_units" type="number" min="0" step="1" value="${s.enrolled_units}" required></label><label>Failed subjects<input name="failed_count" type="number" min="0" step="1" value="${s.failed_count}" required></label><label>Incomplete grades<input name="incomplete_count" type="number" min="0" step="1" value="${s.incomplete_count}" required></label><label>Dropped subjects<input name="dropped_count" type="number" min="0" step="1" value="${s.dropped_count}" required></label><label class="wide">Grade-document reference<input name="evidence_reference" maxlength="500" value="${escapeHtml(s.evidence_reference)}" required></label></div><button class="btn btn-primary full">Resubmit for verification</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("correction-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("correct_submission", {
        p_submission_id: id,
        p_gwa: Number(f.get("gwa")),
        p_enrolled_units: Number(f.get("enrolled_units")),
        p_failed_count: Number(f.get("failed_count")),
        p_incomplete_count: Number(f.get("incomplete_count")),
        p_dropped_count: Number(f.get("dropped_count")),
        p_evidence_reference: f.get("evidence_reference").trim(),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Corrections resubmitted for verification.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  function registerScholar() {
    modal(
      `<div class="modal-body"><h3>Register a scholar</h3><p class="muted">Creates an Auth account and a scholar profile. This uses the signed-in staff session and a secure server-side function.</p><form id="register-form"><label>Full name<input name="full_name" required maxlength="120"></label><label>Student ID<input name="student_id" required maxlength="40"></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" type="password" minlength="8" required></label><label>Scholarship program<select name="program_id" required>${cache.programs.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select></label><button class="btn btn-primary full">Create scholar and assign program</button></form><div id="modal-message" class="message"></div><p class="footer-note">The secure function must be deployed before this action can work.</p></div>`,
    );
    $("register-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.functions.invoke("staff-create-scholar", {
        body: {
          full_name: f.get("full_name").trim(),
          student_id: f.get("student_id").trim(),
          email: f.get("email").trim(),
          password: f.get("password"),
          program_id: f.get("program_id"),
        },
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Scholar registered and assigned.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  function assignScholar(id) {
    modal(
      `<div class="modal-body"><h3>Assign scholarship program</h3><form id="assign-form"><label>Program<select name="program_id" required>${cache.programs.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("")}</select></label><button class="btn btn-primary full">Save assignment</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("assign-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("assign_scholar_program", {
        p_scholar_id: id,
        p_program_id: f.get("program_id"),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Assignment saved.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  function editScholar(id) {
    if (profile.role !== "staff") return;
    const scholar = cache.scholars.find((person) => person.id === id);
    if (!scholar) return;
    modal(
      `<div class="modal-body"><h3>Edit scholar information</h3><form id="scholar-form"><label>Full name<input name="full_name" maxlength="120" required value="${escapeHtml(scholar.full_name)}"></label><label>Student ID<input name="student_id" maxlength="40" required value="${escapeHtml(scholar.student_id || "")}"></label><button class="btn btn-primary full">Save changes</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("scholar-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("update_scholar_profile", {
        p_scholar_id: id,
        p_full_name: f.get("full_name").trim(),
        p_student_id: f.get("student_id").trim(),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Scholar information updated.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  function editPolicy(id) {
    if (profile.role !== "staff") return;
    const program = cache.programs.find((item) => item.id === id);
    modal(
      `<div class="modal-body"><h3>${program ? "Edit policy" : "Add scholarship policy"}</h3><form id="policy-form"><div class="form-grid"><label class="wide">Program name<input name="name" maxlength="100" required value="${escapeHtml(program?.name || "")}"></label><label>Maximum GWA<input name="max_gwa" type="number" min="1" max="5" step=".01" required value="${program?.max_gwa ?? ""}"></label><label>Minimum units<input name="min_units" type="number" min="0" step="1" required value="${program?.min_units ?? 0}"></label><label>Maximum failed<input name="max_failed" type="number" min="0" step="1" required value="${program?.max_failed ?? 0}"></label><label>Maximum incomplete<input name="max_incomplete" type="number" min="0" step="1" required value="${program?.max_incomplete ?? 0}"></label><label>Maximum dropped<input name="max_dropped" type="number" min="0" step="1" required value="${program?.max_dropped ?? 0}"></label><label class="wide">Submission deadline<input name="deadline" type="datetime-local" required value="${program ? new Date(new Date(program.deadline).getTime() - new Date(program.deadline).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}"></label></div><button class="btn btn-primary full">Save policy</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("policy-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("save_scholarship_program", {
        p_program_id: id || null,
        p_name: f.get("name").trim(),
        p_max_gwa: Number(f.get("max_gwa")),
        p_min_units: Number(f.get("min_units")),
        p_max_failed: Number(f.get("max_failed")),
        p_max_incomplete: Number(f.get("max_incomplete")),
        p_max_dropped: Number(f.get("max_dropped")),
        p_deadline: new Date(f.get("deadline")).toISOString(),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Policy saved.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  async function evaluate(id) {
    const { error } = await sb.rpc("evaluate_compliance", {
      p_submission_id: id,
    });
    if (error) {
      toast(error.message);
      return;
    }
    toast("Compliance evaluation saved.");
    await loadData();
    render();
  }
  async function decision(id) {
    const s = cache.submissions.find((x) => x.id === id);
    if (!s) return;
    modal(
      `<div class="modal-body"><h3>Renewal decision</h3><p class="muted">Only a compliant, verified submission can be approved.</p><form id="decision-form"><label>Decision<select name="decision"><option value="Approved">Approved</option><option value="Held">Held</option></select></label><label>Decision note<textarea name="note" required></textarea></label><button class="btn btn-primary full">Save decision</button></form><div id="modal-message" class="message"></div></div>`,
    );
    $("decision-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { error } = await sb.rpc("record_renewal_decision", {
        p_submission_id: id,
        p_decision: f.get("decision"),
        p_note: f.get("note").trim(),
      });
      if (error) {
        $("modal-message").textContent = error.message;
        return;
      }
      toast("Renewal decision saved.");
      $("modal").close();
      await loadData();
      render();
    });
  }
  init();
})();
