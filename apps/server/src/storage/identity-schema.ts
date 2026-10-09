import type { Generated } from "kysely";

/** Physical tables defined by migrations/d1; booleans and timestamps retain SQLite types. */
export interface IdentityDatabase {
  identity_user: {
    id: string;
    name: string;
    email: string;
    emailVerified: Generated<0 | 1>;
    image: string | null;
    createdAt: string;
    updatedAt: string;
    authEpoch: Generated<number>;
  };
  identity_session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
    updatedAt: string;
    authEpoch: Generated<number>;
  };
  identity_account: {
    id: string;
    userId: string;
    accountId: string;
    providerId: string;
    accessToken: string | null;
    refreshToken: string | null;
    idToken: string | null;
    accessTokenExpiresAt: string | null;
    refreshTokenExpiresAt: string | null;
    scope: string | null;
    password: string | null;
    createdAt: string;
    updatedAt: string;
  };
  identity_verification: {
    id: string;
    identifier: string;
    value: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  identity_preferences: {
    user_id: string;
    language: "en" | "zh-Hans" | "zh-Hant" | "ja";
    revision: number;
  };
  identity_operator: {
    singleton: Generated<1>;
    user_id: string;
    operation_id: string;
    created_at: number;
  };
  identity_registration: {
    authorization_id: string;
    user_id: string;
    email: string;
    payload_hash: string;
    operation_id: string;
    created_at: number;
  };
  identity_token: {
    token_hash: string;
    user_id: string;
    kind: "verify_email" | "reset_password";
    expires_at: number;
    created_at: number;
    consumed_at: number | null;
    consumption_id: string | null;
  };
  identity_mail: {
    id: string;
    user_id: string;
    token_hash: string;
    payload_ciphertext: string;
    created_at: number;
    next_attempt_at: number;
    attempts: Generated<number>;
    lease_id: string | null;
    lease_expires_at: number | null;
    delivered_at: number | null;
    cancelled_at: number | null;
  };
  identity_audit: {
    id: string;
    actor_user_id: string;
    target_user_id: string;
    action: "operator_password_reset_requested";
    reason: string;
    created_at: number;
  };
  resource_directory: {
    id: string;
    kind: "server" | "conversation";
    name: string;
    creator_id: string;
    lifecycle: "pending" | "ready";
    payload_hash: string;
    created_at: number;
  };
  resource_membership_index: { resource_id: string; user_id: string };
  block_candidates: {
    user_id: string;
    target_id: string;
    conversation_id: string;
  };
  instance_capability: {
    user_id: string;
    create_servers: 0 | 1;
    granted_by: string;
    updated_at: number;
  };
  directory_audit: {
    id: string;
    actor_id: string;
    target_id: string;
    action: "server_creation_permission";
    allowed: 0 | 1;
    created_at: number;
  };
  instance_settings: {
    id: Generated<1>;
    name: string;
    icon_key: string | null;
    icon_type: "image/png" | "image/jpeg" | "image/webp" | null;
    invite_policy: "members" | "owners";
    updated_at: number;
    icon_cleanup_cursor: string | null;
  };
}
