import ownerSchema from "./migrations/0001_owner.sql?raw";
import messagingSchema from "./migrations/0002_messaging.sql?raw";
import invitesSchema from "./migrations/0003_invites.sql?raw";
import attachmentsSchema from "./migrations/0004_attachments.sql?raw";
import directMessagesSchema from "./migrations/0005_direct_messages.sql?raw";
import realtimeSchema from "./migrations/0006_realtime.sql?raw";
import type { MemberRole } from "@vaskel/contracts/resources";
import type { AttachmentTable } from "./attachments/types";
import type { Generated } from "kysely";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";

export interface OwnerState {
  id: number;
  owner_kind: "server" | "conversation";
  owner_id: string;
  name: string;
  version: number;
  permission_version: number;
  generation: string;
  high_water: number;
  replay_floor: number;
  search_policy: string;
  attachment_bytes: number;
  members_may_invite: number;
}
export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  body: string | null;
  version: number;
  created_sequence: number;
  updated_sequence: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  quote_json: string | null;
}
export interface OwnerDatabase {
  channel_occupancy: { channel_id: string; revision: number; summary: string };
  server_initialization: {
    id: number;
    name: string;
    owner_id: string;
    first_channel_name: string;
  };
  direct_pair: {
    id: number;
    conversation_id: string;
    first_user_id: string;
    second_user_id: string;
  };
  direct_blocks: { user_id: string; blocked: number; revision: number };
  block_receipts: {
    user_id: string;
    command_id: string;
    payload_hash: string;
    blocked: number;
    revision: number;
    accepted_at: number;
  };
  owner_state: Omit<
    OwnerState,
    "attachment_bytes" | "members_may_invite" | "permission_version"
  > & {
    attachment_bytes: Generated<number>;
    members_may_invite: Generated<number>;
    permission_version: Generated<number>;
  };
  attachments: AttachmentTable;
  attachment_incidents: {
    id: string;
    file_id: string;
    operator_id: string;
    quarantined: number;
    preservation_hold: number;
    incident_reference: string;
    recorded_at: number;
  };
  members: { user_id: string; role: MemberRole };
  channels: {
    id: string;
    name: string;
    private: number;
    version: number;
    kind: Generated<"text" | "media">;
    topic: Generated<string | null>;
    position: Generated<number>;
  };
  media_invalidations: {
    channel_id: string;
    user_id: string;
    permission_generation: number;
    next_attempt_at: number;
    attempts: Generated<number>;
    lease_id: Generated<string | null>;
    lease_expires_at: Generated<number | null>;
  };
  channel_members: { channel_id: string; user_id: string };
  messages: MessageRow;
  reactions: {
    message_id: string;
    user_id: string;
    emoji: string;
    created_at: number;
  };
  mentions: {
    message_id: string;
    user_id: string;
    channel_id: string;
    created_sequence: number;
  };
  deleted_payloads: {
    message_id: string;
    body: string;
    eligible_at: number;
    quote_json: Generated<string | null>;
  };
  events: {
    sequence: number;
    previous_sequence: number | null;
    channel_id: string;
    operation: "send" | "edit" | "delete";
    message_id: string;
  };
  channel_progress: { channel_id: string; last_sequence: number };
  command_receipts: {
    user_id: string;
    operation: string;
    command_id: string;
    payload_hash: string;
    message_id: string;
    sequence: number;
    version: number;
    issued_at: number;
    accepted_at: number;
  };
  read_cursors: { user_id: string; channel_id: string; sequence: number };
  socket_tickets: {
    ticket_hash: string;
    user_id: string;
    session_id: string;
    channel_id: string;
    expires_at: number;
    lease_expires_at: number;
  };
  invites: {
    token_hash: string;
    creator_id: string;
    expires_at: number;
    max_uses: number;
    uses: number;
    revoked: number;
    created_at: Generated<number>;
  };
  invite_joins: { token_hash: string; user_id: string };
  registration_authorizations: {
    id: string;
    token_hash: string;
    user_id: string;
    expires_at: number;
    redeemed: number;
    created_at: number;
  };
}
export function openOwnerDatabase(
  storage: DurableObjectStorage,
  actorId?: string,
) {
  migrateActorStorage(
    storage,
    [
      { version: 1, name: "message-owner-core", sql: ownerSchema },
      { version: 2, name: "message-owner-messaging", sql: messagingSchema },
      { version: 3, name: "message-owner-invites", sql: invitesSchema },
      { version: 4, name: "message-owner-attachments", sql: attachmentsSchema },
      {
        version: 5,
        name: "message-owner-direct-messages",
        sql: directMessagesSchema,
      },
      { version: 6, name: "message-owner-realtime", sql: realtimeSchema },
    ],
    { schema: "message_owner", actorId },
  );
  return createActorDatabase<OwnerDatabase>(storage);
}
