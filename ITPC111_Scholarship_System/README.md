# ITPC111 Student Scholarship Monitoring and Academic Compliance System

A browser-based MVP built with HTML, CSS, JavaScript, Supabase Auth, PostgreSQL, RLS, and database RPC functions.

## Included
- Scholar signup/sign-in and profile creation trigger
- Scholar submission form with validation and unique semester constraint
- Staff verification / return workflow
- Program-configurable compliance evaluation
- Controlled renewal decisions and audit events
- Dashboard metrics, search, and filters
- Responsive interface

## Important security notes
- `config.js` may contain the Supabase project URL and publishable/anon key only.
- Never place a Supabase `service_role` key in frontend code.
- The first signup always creates a `scholar` role. To create the first staff user, create an account normally, then promote that profile to `staff` from the Supabase SQL Editor after verifying the account:
  ```sql
  update public.profiles set role = 'staff'
  where id = (select id from auth.users where email = 'staff@example.com');
  ```
  Use a synthetic test account and do not share staff credentials.
- Staff scholar creation is handled by `supabase/functions/staff-create-scholar`. Deploy it with the Supabase URL, anon key, and service-role key configured as Edge Function secrets; the service-role key must never be placed in `config.js` or browser code. It verifies the caller as staff, creates a scholar account, and assigns the selected saved program.
- RLS is enabled. Privileged workflow transitions have no direct client update policy and use SQL functions.
- Before deployment, review every SQL function and policy with your instructor/security reviewer.

## Setup
1. Create a Supabase project.
2. In SQL Editor, run `supabase/schema.sql` on a fresh project.
3. Copy the project URL and publishable (or anon) key from Supabase Project Settings > API.
4. Paste both into `config.js`.
5. Serve the folder from a local web server. For example, in the project folder:
   ```bash
   python -m http.server 8000
   ```
   Open `http://localhost:8000`. Avoid opening `index.html` as a `file://` URL.
6. Create a scholar account using the Create scholar account tab.
7. Create a second synthetic account, then promote it to staff using the SQL shown above.
8. In Supabase SQL Editor, assign the test scholar to a program using the SQL below, substituting the actual UUID values:
   ```sql
   insert into public.scholar_assignments (scholar_id, program_id, assigned_by)
   select
     (select id from public.profiles where student_id = 'TEST-001'),
     (select id from public.scholarship_programs where name = 'Merit Scholar'),
     (select id from public.profiles where role = 'staff' limit 1);
   ```
9. Sign in as scholar and submit a semester record. Sign in as staff to verify, evaluate, and record a renewal decision.

## Known MVP limitations to address
- Staff registration UI requires an Edge Function for securely creating Auth users; do not implement it by exposing an admin key.
- Returned submissions can be corrected and resubmitted; the database resets verification, evaluation, and renewal state and records an audit event.
- The dashboard metrics are scoped by its semester selector. The submissions view searches by student ID or name and filters by program or compliance.
- For the examination's exact deadline test, seed controlled test data in a test environment. The database timestamp defaults to submission time, so the one-minute-late case needs a controlled test fixture or a timestamp-safe test-only seed.
- Audit history records workflow changes; profile/assignment changes should also be audited if required by your instructor.
- Assignment edits are visible in the current assignment list. If assignment history is required beyond the stated workflow logs, add a dedicated assignment audit event in a future schema revision.

## Policy thresholds seeded
- Merit Scholar: maximum GWA 1.75, minimum units 18, zero failed/incomplete/dropped subjects.
- Community Scholar: maximum GWA 2.25, minimum units 15, zero failed/incomplete subjects, at most one dropped subject.
- Deadline: 2026-10-30 17:00 Asia/Manila.

## Examination test checklist
Run TC01–TC10 from the PDF and record actual results, screenshots, and defects. Do not mark a test passed until you execute it.
