create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  student_id text unique,
  role text not null default 'scholar' check (role in ('scholar','staff')),
  created_at timestamptz not null default now()
);

create table public.scholarship_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  max_gwa numeric(3,2) not null check (max_gwa between 1 and 5),
  min_units integer not null check (min_units >= 0),
  max_failed integer not null check (max_failed >= 0),
  max_incomplete integer not null check (max_incomplete >= 0),
  max_dropped integer not null check (max_dropped >= 0),
  deadline timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.scholar_assignments (
  id uuid primary key default gen_random_uuid(),
  scholar_id uuid not null unique references public.profiles(id),
  program_id uuid not null references public.scholarship_programs(id),
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now()
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  scholar_id uuid not null references public.profiles(id),
  academic_year text not null check (academic_year ~ '^20[0-9]{2}-20[0-9]{2}$'),
  semester integer not null check (semester in (1,2,3)),
  gwa numeric(3,2) not null check (gwa between 1 and 5),
  enrolled_units integer not null check (enrolled_units >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  incomplete_count integer not null default 0 check (incomplete_count >= 0),
  dropped_count integer not null default 0 check (dropped_count >= 0),
  evidence_reference text not null check (length(trim(evidence_reference)) > 0),
  submitted_at timestamptz not null default now(),
  verification_status text not null default 'Pending' check (verification_status in ('Pending','Verified','Returned')),
  verification_reason text,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  compliance_status text not null default 'Not Evaluated' check (compliance_status in ('Not Evaluated','Compliant','With Deficiency')),
  compliance_reasons jsonb not null default '[]'::jsonb,
  evaluated_by uuid references public.profiles(id),
  evaluated_at timestamptz,
  renewal_decision text not null default 'Pending' check (renewal_decision in ('Pending','Approved','Held')),
  decision_note text,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  unique (scholar_id, academic_year, semester)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.submissions(id),
  scholar_id uuid not null references public.profiles(id),
  actor_id uuid not null references public.profiles(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_submissions_scholar on public.submissions(scholar_id);
create index idx_submissions_semester on public.submissions(academic_year,semester);
create index idx_submissions_status on public.submissions(verification_status,compliance_status);
create index idx_audit_submission on public.audit_logs(submission_id,created_at desc);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, full_name, student_id, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name',''),
    nullif(trim(new.raw_user_meta_data ->> 'student_id'),''),
    'scholar'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.profiles where id = (select auth.uid()) and role = 'staff');
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

alter table public.profiles enable row level security;
alter table public.scholarship_programs enable row level security;
alter table public.scholar_assignments enable row level security;
alter table public.submissions enable row level security;
alter table public.audit_logs enable row level security;

create policy "Read own profile or staff reads all" on public.profiles
for select to authenticated using (id = (select auth.uid()) or (select public.is_staff()));
create policy "Authenticated read programs" on public.scholarship_programs
for select to authenticated using (true);
create policy "Read own assignment or staff reads all" on public.scholar_assignments
for select to authenticated using (scholar_id = (select auth.uid()) or (select public.is_staff()));
create policy "Read own submission or staff reads all" on public.submissions
for select to authenticated using (scholar_id = (select auth.uid()) or (select public.is_staff()));
create policy "Staff read audit history" on public.audit_logs
for select to authenticated using ((select public.is_staff()));


insert into public.scholarship_programs(name,max_gwa,min_units,max_failed,max_incomplete,max_dropped,deadline)
values
 ('Merit Scholar',1.75,18,0,0,0,'2026-10-30 17:00:00+08'),
 ('Community Scholar',2.25,15,0,0,1,'2026-10-30 17:00:00+08')
on conflict(name) do nothing;

create or replace function public.require_staff()
returns void language plpgsql security definer set search_path = ''
as $$
begin
 if not public.is_staff() then raise exception 'Staff access required'; end if;
end;
$$;

create or replace function public.submit_grades(
  scholar_id uuid, academic_year text, semester integer, gwa numeric,
  enrolled_units integer, failed_count integer, incomplete_count integer,
  dropped_count integer, evidence_reference text
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare new_id uuid;
begin
 if (select auth.uid()) is null or scholar_id <> (select auth.uid()) then raise exception 'You may only submit your own grades'; end if;
 if not exists(select 1 from public.scholar_assignments a where a.scholar_id = (select auth.uid())) then raise exception 'No scholarship program assigned'; end if;
 if gwa < 1 or gwa > 5 or enrolled_units < 0 or failed_count < 0 or incomplete_count < 0 or dropped_count < 0 then raise exception 'Invalid academic summary values'; end if;
 if length(trim(coalesce(evidence_reference,''))) = 0 then raise exception 'Grade-document reference is required'; end if;
 insert into public.submissions(scholar_id,academic_year,semester,gwa,enrolled_units,failed_count,incomplete_count,dropped_count,evidence_reference)
 values(scholar_id,academic_year,semester,gwa,enrolled_units,failed_count,incomplete_count,dropped_count,trim(evidence_reference))
 returning id into new_id;
 insert into public.audit_logs(submission_id,scholar_id,actor_id,action,details)
 values(new_id,scholar_id,(select auth.uid()),'SUBMITTED',jsonb_build_object('academic_year',academic_year,'semester',semester));
 return new_id;
end;
$$;

create or replace function public.verify_submission(p_submission_id uuid,p_outcome text,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare s public.submissions%rowtype;
begin
 perform public.require_staff();
 if p_outcome not in ('Verified','Returned') then raise exception 'Invalid verification outcome'; end if;
 if length(trim(coalesce(p_reason,'')))=0 then raise exception 'A verification reason is required'; end if;
 select * into s from public.submissions where id=p_submission_id for update;
 if not found then raise exception 'Submission not found'; end if;
 update public.submissions set verification_status=p_outcome,verification_reason=trim(p_reason),
   verified_by=(select auth.uid()),verified_at=now(),
   compliance_status='Not Evaluated',compliance_reasons='[]'::jsonb,evaluated_by=null,evaluated_at=null,
   renewal_decision='Pending',decision_note=null,decided_by=null,decided_at=null
 where id=p_submission_id;
 insert into public.audit_logs(submission_id,scholar_id,actor_id,action,details)
 values(s.id,s.scholar_id,(select auth.uid()),'VERIFICATION',jsonb_build_object('outcome',p_outcome,'reason',trim(p_reason)));
end;
$$;

create or replace function public.correct_submission(
 p_submission_id uuid,p_gwa numeric,p_enrolled_units integer,p_failed_count integer,
 p_incomplete_count integer,p_dropped_count integer,p_evidence_reference text
) returns void language plpgsql security definer set search_path = ''
as $$
declare s public.submissions%rowtype;
begin
 select * into s from public.submissions where id=p_submission_id for update;
 if not found or (select auth.uid()) is null or s.scholar_id <> (select auth.uid()) then raise exception 'Submission not found or access denied'; end if;
 if s.verification_status <> 'Returned' then raise exception 'Only returned submissions may be corrected'; end if;
 if p_gwa<1 or p_gwa>5 or p_enrolled_units<0 or p_failed_count<0 or p_incomplete_count<0 or p_dropped_count<0 or length(trim(coalesce(p_evidence_reference,'')))=0 then raise exception 'Invalid corrected values'; end if;
 update public.submissions set gwa=p_gwa,enrolled_units=p_enrolled_units,failed_count=p_failed_count,
  incomplete_count=p_incomplete_count,dropped_count=p_dropped_count,evidence_reference=trim(p_evidence_reference),
  submitted_at=now(),verification_status='Pending',verification_reason=null,verified_by=null,verified_at=null,
  compliance_status='Not Evaluated',compliance_reasons='[]'::jsonb,evaluated_by=null,evaluated_at=null,
  renewal_decision='Pending',decision_note=null,decided_by=null,decided_at=null
 where id=p_submission_id;
 insert into public.audit_logs(submission_id,scholar_id,actor_id,action,details)
 values(s.id,s.scholar_id,(select auth.uid()),'CORRECTED_AND_RESUBMITTED',jsonb_build_object('previous_verification_reason',s.verification_reason));
end;
$$;

create or replace function public.evaluate_compliance(p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare s public.submissions%rowtype; pol public.scholarship_programs%rowtype; reasons jsonb := '[]'::jsonb; late boolean;
begin
 perform public.require_staff();
 select * into s from public.submissions where id=p_submission_id for update;
 if not found then raise exception 'Submission not found'; end if;
 if s.verification_status <> 'Verified' then raise exception 'Evidence must be verified before evaluation'; end if;
 select p.* into pol from public.scholarship_programs p join public.scholar_assignments a on a.program_id=p.id where a.scholar_id=s.scholar_id;
 if not found then raise exception 'Scholar has no assigned policy'; end if;
 if s.gwa > pol.max_gwa then reasons:=reasons||jsonb_build_array(format('GWA %s exceeds maximum %s',s.gwa,pol.max_gwa)); end if;
 if s.enrolled_units < pol.min_units then reasons:=reasons||jsonb_build_array(format('Enrolled units %s are below minimum %s',s.enrolled_units,pol.min_units)); end if;
 if s.failed_count > pol.max_failed then reasons:=reasons||jsonb_build_array(format('Failed subjects %s exceed allowed %s',s.failed_count,pol.max_failed)); end if;
 if s.incomplete_count > pol.max_incomplete then reasons:=reasons||jsonb_build_array(format('Incomplete grades %s exceed allowed %s',s.incomplete_count,pol.max_incomplete)); end if;
 if s.dropped_count > pol.max_dropped then reasons:=reasons||jsonb_build_array(format('Dropped subjects %s exceed allowed %s',s.dropped_count,pol.max_dropped)); end if;
 late := s.submitted_at > pol.deadline;
 if late then reasons:=reasons||jsonb_build_array('Submission was received after the deadline'); end if;
 update public.submissions set compliance_status=case when jsonb_array_length(reasons)=0 then 'Compliant' else 'With Deficiency' end,
   compliance_reasons=reasons,evaluated_by=(select auth.uid()),evaluated_at=now(),
   renewal_decision='Pending',decision_note=null,decided_by=null,decided_at=null
 where id=p_submission_id;
 insert into public.audit_logs(submission_id,scholar_id,actor_id,action,details)
 values(s.id,s.scholar_id,(select auth.uid()),'COMPLIANCE_EVALUATED',jsonb_build_object('status',case when jsonb_array_length(reasons)=0 then 'Compliant' else 'With Deficiency' end,'reasons',reasons));
 return jsonb_build_object('status',case when jsonb_array_length(reasons)=0 then 'Compliant' else 'With Deficiency' end,'reasons',reasons);
end;
$$;

create or replace function public.record_renewal_decision(p_submission_id uuid,p_decision text,p_note text)
returns void language plpgsql security definer set search_path = ''
as $$
declare s public.submissions%rowtype;
begin
 perform public.require_staff();
 if p_decision not in ('Approved','Held') then raise exception 'Decision must be Approved or Held'; end if;
 if length(trim(coalesce(p_note,'')))=0 then raise exception 'Decision note is required'; end if;
 select * into s from public.submissions where id=p_submission_id for update;
 if not found then raise exception 'Submission not found'; end if;
 if s.verification_status <> 'Verified' or s.compliance_status='Not Evaluated' then raise exception 'Submission must be verified and evaluated before renewal decision'; end if;
 if p_decision='Approved' and s.compliance_status <> 'Compliant' then raise exception 'A deficient submission cannot be approved'; end if;
 update public.submissions set renewal_decision=p_decision,decision_note=trim(p_note),decided_by=(select auth.uid()),decided_at=now() where id=p_submission_id;
 insert into public.audit_logs(submission_id,scholar_id,actor_id,action,details)
 values(s.id,s.scholar_id,(select auth.uid()),'RENEWAL_DECISION',jsonb_build_object('decision',p_decision,'note',trim(p_note)));
end;
$$;

create or replace function public.assign_scholar_program(p_scholar_id uuid,p_program_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
 perform public.require_staff();
 if not exists(select 1 from public.profiles where id=p_scholar_id and role='scholar') then raise exception 'Scholar profile not found'; end if;
 if not exists(select 1 from public.scholarship_programs where id=p_program_id) then raise exception 'Program not found'; end if;
 insert into public.scholar_assignments(scholar_id,program_id,assigned_by)
 values(p_scholar_id,p_program_id,(select auth.uid()))
 on conflict(scholar_id) do update set program_id=excluded.program_id,assigned_by=excluded.assigned_by,assigned_at=now();
end;
$$;

create or replace function public.save_scholarship_program(
 p_program_id uuid,p_name text,p_max_gwa numeric,p_min_units integer,
 p_max_failed integer,p_max_incomplete integer,p_max_dropped integer,p_deadline timestamptz
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare saved_id uuid;
begin
 perform public.require_staff();
 if length(trim(coalesce(p_name,'')))=0 then raise exception 'Program name is required'; end if;
 if p_program_id is null then
  insert into public.scholarship_programs(name,max_gwa,min_units,max_failed,max_incomplete,max_dropped,deadline)
  values(trim(p_name),p_max_gwa,p_min_units,p_max_failed,p_max_incomplete,p_max_dropped,p_deadline)
  returning id into saved_id;
 else
  update public.scholarship_programs set name=trim(p_name),max_gwa=p_max_gwa,min_units=p_min_units,
   max_failed=p_max_failed,max_incomplete=p_max_incomplete,max_dropped=p_max_dropped,deadline=p_deadline
  where id=p_program_id returning id into saved_id;
  if not found then raise exception 'Program not found'; end if;
 end if;
 return saved_id;
end;
$$;

create or replace function public.update_scholar_profile(p_scholar_id uuid,p_full_name text,p_student_id text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
 perform public.require_staff();
 if length(trim(coalesce(p_full_name,'')))=0 or length(trim(coalesce(p_student_id,'')))=0 then
  raise exception 'Name and student ID are required';
 end if;
 update public.profiles set full_name=trim(p_full_name),student_id=trim(p_student_id)
 where id=p_scholar_id and role='scholar';
 if not found then raise exception 'Scholar profile not found'; end if;
end;
$$;

grant execute on function public.submit_grades(uuid,text,integer,numeric,integer,integer,integer,integer,text) to authenticated;
grant execute on function public.verify_submission(uuid,text,text) to authenticated;
grant execute on function public.correct_submission(uuid,numeric,integer,integer,integer,integer,text) to authenticated;
grant execute on function public.evaluate_compliance(uuid) to authenticated;
grant execute on function public.record_renewal_decision(uuid,text,text) to authenticated;
grant execute on function public.assign_scholar_program(uuid,uuid) to authenticated;
grant execute on function public.save_scholarship_program(uuid,text,numeric,integer,integer,integer,integer,timestamptz) to authenticated;
grant execute on function public.update_scholar_profile(uuid,text,text) to authenticated;
revoke all on function public.require_staff() from public;
revoke all on function public.submit_grades(uuid,text,integer,numeric,integer,integer,integer,integer,text) from public;
revoke all on function public.verify_submission(uuid,text,text) from public;
revoke all on function public.correct_submission(uuid,numeric,integer,integer,integer,integer,text) from public;
revoke all on function public.evaluate_compliance(uuid) from public;
revoke all on function public.record_renewal_decision(uuid,text,text) from public;
revoke all on function public.assign_scholar_program(uuid,uuid) from public;
revoke all on function public.save_scholarship_program(uuid,text,numeric,integer,integer,integer,integer,timestamptz) from public;
revoke all on function public.update_scholar_profile(uuid,text,text) from public;
grant execute on function public.require_staff() to authenticated;
grant execute on function public.submit_grades(uuid,text,integer,numeric,integer,integer,integer,integer,text) to authenticated;
grant execute on function public.verify_submission(uuid,text,text) to authenticated;
grant execute on function public.correct_submission(uuid,numeric,integer,integer,integer,integer,text) to authenticated;
grant execute on function public.evaluate_compliance(uuid) to authenticated;
grant execute on function public.record_renewal_decision(uuid,text,text) to authenticated;
grant execute on function public.assign_scholar_program(uuid,uuid) to authenticated;
grant execute on function public.save_scholarship_program(uuid,text,numeric,integer,integer,integer,integer,timestamptz) to authenticated;
grant execute on function public.update_scholar_profile(uuid,text,text) to authenticated;
