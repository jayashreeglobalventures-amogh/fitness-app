-- 0009_health_profile: optional health profile (PRD 4), kept apart from the ordinary profile.
--  * Nothing is collected until the person gives explicit consent (user_consents); they can withdraw it.
--  * Measurements are dated records - a new entry never overwrites an earlier one.
--  * Private by default, visibility per field. Finance managers and Super Admins get no access from their role.
--  * Enforced by the DATABASE, not just the app: row-level security lets the app's connection read and write only the
--    signed-in person's own health rows (app.user_id, set per transaction). The only way to see anyone else's health
--    data is health_shared_with(), which applies the person's sharing choices and returns only what may be seen.

-- Who is signed in for this transaction (set by the app with set_config('app.user_id', ..., true)).
CREATE FUNCTION app_user_id() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::bigint $$;

CREATE TABLE user_consents (
  consent_id bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(user_id),
  kind       text NOT NULL CHECK (kind IN ('HEALTH_DATA')),
  version    int NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX user_consents_active ON user_consents (user_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE health_profiles (
  user_id            bigint PRIMARY KEY REFERENCES users(user_id),
  units              text NOT NULL DEFAULT 'METRIC' CHECK (units IN ('METRIC', 'IMPERIAL')),
  fitness_level      text CHECK (fitness_level IN ('BEGINNER', 'INTERMEDIATE', 'ADVANCED')),
  activity_level     text CHECK (activity_level IN ('SEDENTARY', 'LIGHT', 'MODERATE', 'ACTIVE', 'VERY_ACTIVE')),
  goals              text[] NOT NULL DEFAULT '{}' CHECK (goals <@ ARRAY['FAT_LOSS','MUSCLE_GAIN','ENDURANCE','STRENGTH','STEPS','CONSISTENCY']),
  target_weight_kg   numeric(5,1) CHECK (target_weight_kg BETWEEN 20 AND 350),
  target_daily_steps int CHECK (target_daily_steps BETWEEN 1000 AND 100000),
  considerations     text CHECK (length(considerations) <= 1000),
  -- per field: PRIVATE | ADMINS | MEMBERS | PUBLIC (missing = PRIVATE)
  visibility         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE health_measurements (
  measurement_id bigserial PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users(user_id),
  measured_on    date NOT NULL,
  height_cm      numeric(5,1) CHECK (height_cm BETWEEN 50 AND 250),
  weight_kg      numeric(5,1) CHECK (weight_kg BETWEEN 20 AND 350),
  body_fat_pct   numeric(4,1) CHECK (body_fat_pct BETWEEN 2 AND 75),
  waist_cm       numeric(5,1) CHECK (waist_cm BETWEEN 30 AND 250),
  resting_hr     int CHECK (resting_hr BETWEEN 25 AND 220),
  note           text CHECK (length(note) <= 200),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  CHECK (num_nonnulls(height_cm, weight_kg, body_fat_pct, waist_cm, resting_hr) > 0)
);
CREATE INDEX health_measurements_user ON health_measurements (user_id, measured_on DESC, measurement_id DESC);

-- Exceptional support access: granted by the person themself, to one named person, for a limited time.
CREATE TABLE health_support_grants (
  grant_id        bigserial PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(user_id),
  grantee_user_id bigint NOT NULL REFERENCES users(user_id),
  reason          text CHECK (length(reason) <= 300),
  granted_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK (grantee_user_id <> user_id),
  CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '72 hours')
);

-- Row-level security: the app's connection sees only the signed-in person's rows (a grantee also sees grants made to them).
ALTER TABLE user_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE health_support_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON user_consents USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own ON health_profiles USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own ON health_measurements USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY own ON health_support_grants USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY granted_to_me ON health_support_grants FOR SELECT USING (grantee_user_id = app_user_id());

-- Whether one field may be shown, given its visibility and how the viewer relates to the person.
CREATE FUNCTION health_field_visible(lvl text, is_member boolean, is_admin boolean, is_support boolean, admins_at_most boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT is_support
      OR (admins_at_most AND is_admin AND coalesce(lvl, 'PRIVATE') <> 'PRIVATE')
      OR (NOT admins_at_most AND (
            lvl = 'PUBLIC'
         OR (lvl = 'MEMBERS' AND (is_member OR is_admin))
         OR (lvl = 'ADMINS' AND is_admin)))
$$;

-- What `p_viewer` may see of `p_owner`'s health profile, or NULL for nothing. The viewer must be the signed-in person.
-- Members: in a challenge together (participants, or that challenge's admins). Admins: CHALLENGE_ADMIN of a challenge the
-- person takes part in. A finance-manager or Super Admin role grants nothing by itself. Support: an unexpired grant.
CREATE FUNCTION health_shared_with(p_viewer bigint, p_owner bigint, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_member boolean; is_admin boolean; is_support boolean;
  prof health_profiles%ROWTYPE; vis jsonb; vals jsonb := '{}'::jsonb;
  h record; w record; f record; wa record; hr record;
BEGIN
  IF p_viewer IS NULL OR p_owner IS NULL OR p_viewer = p_owner THEN RETURN NULL; END IF;
  IF p_viewer IS DISTINCT FROM app_user_id() THEN RAISE EXCEPTION 'health_shared_with: the viewer must be the signed-in user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_consents WHERE user_id = p_owner AND kind = 'HEALTH_DATA' AND revoked_at IS NULL) THEN RETURN NULL; END IF;

  SELECT EXISTS (SELECT 1 FROM health_support_grants WHERE user_id = p_owner AND grantee_user_id = p_viewer AND revoked_at IS NULL AND expires_at > p_at) INTO is_support;
  SELECT EXISTS (SELECT 1 FROM participants po JOIN challenge_roles r ON r.challenge_id = po.challenge_id
                  WHERE po.user_id = p_owner AND r.user_id = p_viewer AND r.role = 'CHALLENGE_ADMIN') INTO is_admin;
  SELECT EXISTS (SELECT 1 FROM participants po JOIN participants pv ON pv.challenge_id = po.challenge_id
                  WHERE po.user_id = p_owner AND pv.user_id = p_viewer) INTO is_member;

  SELECT * INTO prof FROM health_profiles WHERE user_id = p_owner;
  vis := coalesce(prof.visibility, '{}'::jsonb);

  SELECT height_cm AS v, measured_on AS d INTO h FROM health_measurements WHERE user_id = p_owner AND height_cm IS NOT NULL ORDER BY measured_on DESC, measurement_id DESC LIMIT 1;
  SELECT weight_kg AS v, measured_on AS d INTO w FROM health_measurements WHERE user_id = p_owner AND weight_kg IS NOT NULL ORDER BY measured_on DESC, measurement_id DESC LIMIT 1;
  SELECT body_fat_pct AS v, measured_on AS d INTO f FROM health_measurements WHERE user_id = p_owner AND body_fat_pct IS NOT NULL ORDER BY measured_on DESC, measurement_id DESC LIMIT 1;
  SELECT waist_cm AS v, measured_on AS d INTO wa FROM health_measurements WHERE user_id = p_owner AND waist_cm IS NOT NULL ORDER BY measured_on DESC, measurement_id DESC LIMIT 1;
  SELECT resting_hr AS v, measured_on AS d INTO hr FROM health_measurements WHERE user_id = p_owner AND resting_hr IS NOT NULL ORDER BY measured_on DESC, measurement_id DESC LIMIT 1;

  IF h.v IS NOT NULL AND health_field_visible(vis->>'height', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('heightCm', jsonb_build_object('value', h.v, 'on', h.d)); END IF;
  IF w.v IS NOT NULL AND health_field_visible(vis->>'weight', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('weightKg', jsonb_build_object('value', w.v, 'on', w.d)); END IF;
  IF w.v IS NOT NULL AND h.v IS NOT NULL AND health_field_visible(vis->>'bmi', is_member, is_admin, is_support, false) THEN
    vals := vals || jsonb_build_object('bmi', jsonb_build_object('value', round(w.v / ((h.v / 100) ^ 2), 1), 'on', w.d));
  END IF;
  IF f.v IS NOT NULL AND health_field_visible(vis->>'bodyFat', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('bodyFatPct', jsonb_build_object('value', f.v, 'on', f.d)); END IF;
  IF wa.v IS NOT NULL AND health_field_visible(vis->>'waist', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('waistCm', jsonb_build_object('value', wa.v, 'on', wa.d)); END IF;
  IF hr.v IS NOT NULL AND health_field_visible(vis->>'restingHr', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('restingHr', jsonb_build_object('value', hr.v, 'on', hr.d)); END IF;
  IF prof.fitness_level IS NOT NULL AND health_field_visible(vis->>'fitnessLevel', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('fitnessLevel', prof.fitness_level); END IF;
  IF prof.activity_level IS NOT NULL AND health_field_visible(vis->>'activityLevel', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('activityLevel', prof.activity_level); END IF;
  IF cardinality(prof.goals) > 0 AND health_field_visible(vis->>'goals', is_member, is_admin, is_support, false) THEN vals := vals || jsonb_build_object('goals', to_jsonb(prof.goals)); END IF;
  IF prof.considerations IS NOT NULL AND health_field_visible(vis->>'considerations', is_member, is_admin, is_support, true) THEN vals := vals || jsonb_build_object('considerations', prof.considerations); END IF;

  IF vals = '{}'::jsonb AND NOT is_support THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('values', vals, 'support', is_support,
    'history', CASE WHEN is_support THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('on', measured_on, 'heightCm', height_cm, 'weightKg', weight_kg, 'bodyFatPct', body_fat_pct, 'waistCm', waist_cm, 'restingHr', resting_hr) ORDER BY measured_on, measurement_id), '[]'::jsonb)
        FROM health_measurements WHERE user_id = p_owner) ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION health_shared_with(bigint, bigint, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fit_app') THEN GRANT EXECUTE ON FUNCTION health_shared_with(bigint, bigint, timestamptz) TO fit_app; END IF;
END $$;
