import { z } from "zod";
import {
  MediaHandleSchema,
  MediaRoomRefSchema,
  PendingMediaCommandSchema,
} from "@vaskel/contracts/media";

const IntentSchema = z.strictObject({
  room: MediaRoomRefSchema,
  label: z.string().max(200),
  canModerate: z.boolean(),
  handle: MediaHandleSchema.nullable(),
  pending: PendingMediaCommandSchema.nullable(),
  hiddenUserIds: z.array(z.uuid()).optional(),
  deafened: z.boolean().optional(),
});
export type CallIntent = z.infer<typeof IntentSchema>;
export class IntentStore {
  private readonly key: string;
  constructor(
    origin: string,
    userId: string,
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >,
  ) {
    this.key = `vaskel:call:${origin}:${userId}`;
  }
  read(): CallIntent | null {
    try {
      const intent = IntentSchema.parse(
        JSON.parse(this.storage.getItem(this.key) ?? "null"),
      );
      return intent;
    } catch {
      this.write(null);
      return null;
    }
  }
  write(intent: CallIntent | null) {
    try {
      if (intent) this.storage.setItem(this.key, JSON.stringify(intent));
      else this.storage.removeItem(this.key);
    } catch {
      /* Calls remain usable when browser storage is disabled. */
    }
  }
  muted(): boolean {
    try {
      return this.storage.getItem(`${this.key}:muted`) === "true";
    } catch {
      return true;
    }
  }
  setMuted(value: boolean) {
    try {
      this.storage.setItem(`${this.key}:muted`, String(value));
    } catch {
      /* Memory-only preference. */
    }
  }
}

const PIP_KEY = "vaskel.media.pip";

export function readPictureInPicture(): boolean {
  try {
    return sessionStorage.getItem(PIP_KEY) !== "false";
  } catch {
    return true;
  }
}

export function deviceToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const fallbackStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

export function privateStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return fallbackStorage;
  }
}

export function writePictureInPicture(enabled: boolean) {
  try {
    sessionStorage.setItem(PIP_KEY, String(enabled));
  } catch {
    /* Memory-only preference. */
  }
}
