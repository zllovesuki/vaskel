// Public, deterministic fixture values. Never derive these from local secrets.
export const fixtureAuthVars = {
  AUTH_ORIGIN: "https://vaskel.test",
  AUTH_SECRET:
    "vaskel_test_auth_secret_never_use_in_production_0000000000000000",
  OPERATOR_BOOTSTRAP_SECRET:
    "vaskel_test_bootstrap_secret_never_use_in_production_000000000000",
  OPERATOR_BOOTSTRAP_EXPIRES_AT: "2099-01-01T00:00:00.000Z",
  MAIL_FROM: "vaskel@example.invalid",
  PUSH_VAPID_SUBJECT: "mailto:vaskel@example.invalid",
  REALTIME_APP_ID: "fixture-app",
  REALTIME_APP_SECRET: "fixture-secret",
  // Small enough to exercise real SQL growth without a production-size workload.
  OWNER_SQL_BUDGET_BYTES: "8388608",
  INSTANCE_ACCOUNT_LIMIT: "256",
  INSTANCE_SERVER_LIMIT: "32",
  INSTANCE_CONVERSATION_LIMIT: "512",
};

export const fixtureDurableObjects = {
  DATABASE_PROBE: { className: "DatabaseProbeDO", useSQLite: true },
};

export const fixtureModuleRules = [
  { type: "Text" as const, include: ["**/*.sql"], fallthrough: true },
  { type: "Data" as const, include: ["**/*.bin"], fallthrough: true },
];
