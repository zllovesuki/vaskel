import { captureError } from "@/client/features/media/capture";
import { SilentAudio } from "@/client/features/media/silent-audio";
import { message } from "@/client/features/i18n/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsumerMediaOutcomeSchema,
  MediaOutcomeSchema,
} from "@vaskel/contracts/media";
import {
  desiredPublications,
  mediaErrorMessage,
  MediaError,
} from "@/client/features/media/protocol";
import { IntentStore } from "@/client/features/media/intent";
import {
  room,
  handle,
  publication,
  participant,
  snapshot,
  FakeStream,
  audioContexts,
} from "@tests/helpers/media";

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("owned silent audio", () => {
  it("loops its source only into its media destination and releases all resources", async () => {
    const contexts = audioContexts();
    const source = new SilentAudio();
    const context = contexts[0]!;
    expect(context.source.loop).toBe(true);
    expect(context.source.connect).toHaveBeenCalledExactlyOnceWith(
      context.output,
    );
    expect(await source.resume()).toBe(true);
    source.dispose();
    source.dispose();
    expect(context.track.readyState).toBe("ended");
    expect(context.source.stop).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.output.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("bounds an activation-blocked resume and cannot revive a disposed source", async () => {
    vi.useFakeTimers();
    const contexts = audioContexts(true);
    const source = new SilentAudio();
    const pending = source.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBe(false);
    source.dispose();
    contexts[0]!.state = "running";
    expect(await source.resume()).toBe(false);
  });
});

describe("call subscription policy", () => {
  it("only receives four visible cameras, permitted audio and the selected screen's audio", () => {
    const state = snapshot();
    state.participants = [
      participant("self"),
      ...Array.from({ length: 8 }, (_, i) =>
        participant(`p${i}`, [
          publication(`mic${i}`, "microphone", `p${i}`),
          publication(`cam${i}`, "camera", `p${i}`),
          publication(`screen${i}`, "screen_video", `p${i}`),
          publication(`audio${i}`, "screen_audio", `p${i}`),
        ]),
      ),
    ];
    state.participants[2]!.muted = true;
    const selected = desiredPublications(state, "self", "screen2", {
      cameras: true,
      screen: true,
    });
    expect(selected.filter((p) => p.source === "camera")).toHaveLength(4);
    expect(selected.filter((p) => p.source === "microphone")).toHaveLength(7);
    expect(selected.filter((p) => p.source.startsWith("screen"))).toEqual([
      publication("screen2", "screen_video", "p2"),
      publication("audio2", "screen_audio", "p2"),
    ]);
    expect(
      desiredPublications(state, "self", "screen2", {
        cameras: false,
        screen: false,
      }).every((p) => p.source === "microphone"),
    ).toBe(true);
    state.participants[0]!.deafened = true;
    expect(
      desiredPublications(state, "self", "screen2", {
        cameras: true,
        screen: true,
      }),
    ).toEqual([]);
  });
});

describe("private refresh intent", () => {
  it("keeps the rotated pending token scoped to account and instance, and clears before leave", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const own = new IntentStore("https://vaskel.test", "self", storage);
    const intent = {
      room,
      label: "Lounge",
      canModerate: false,
      hiddenUserIds: ["33333333-3333-4333-8333-333333333333"],
      handle,
      pending: {
        path: "resume" as const,
        body: {
          handle,
          commandId: "22222222-2222-4222-8222-222222222222",
          issuedAt: 10,
          nextDeviceToken: "b".repeat(64),
        },
      },
    };
    own.write(intent);
    expect(own.read()).toEqual(intent);
    expect(
      new IntentStore("https://other.test", "self", storage).read(),
    ).toBeNull();
    expect(
      new IntentStore("https://vaskel.test", "other", storage).read(),
    ).toBeNull();
    own.write(null);
    expect(own.read()).toBeNull();
  });
  it("rejects a persisted resume that reuses the old capability", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          room,
          label: "Lounge",
          canModerate: false,
          handle,
          pending: {
            path: "resume",
            body: {
              handle,
              commandId: handle.clientId,
              issuedAt: 10,
              nextDeviceToken: handle.deviceToken,
            },
          },
        }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    expect(
      new IntentStore("https://vaskel.test", "self", storage).read(),
    ).toBeNull();
  });
});

describe("consumer completion boundary", () => {
  it("rejects missing consumer maps while accepting valid producer completion and empty consumer maps", () => {
    const completed = {
      kind: "completed",
      operationId: crypto.randomUUID(),
      sessionVersion: 1,
      revision: 1,
    };
    expect(MediaOutcomeSchema.safeParse(completed).success).toBe(true);
    expect(ConsumerMediaOutcomeSchema.safeParse(completed).success).toBe(false);
    expect(
      ConsumerMediaOutcomeSchema.safeParse({ ...completed, subscriptions: [] })
        .success,
    ).toBe(true);
    expect(
      ConsumerMediaOutcomeSchema.safeParse({
        ...completed,
        subscriptions: null,
      }).success,
    ).toBe(false);
    expect(
      ConsumerMediaOutcomeSchema.safeParse({
        ...completed,
        subscriptions: [{}],
      }).success,
    ).toBe(false);
  });
});

describe("safe media presentation boundaries", () => {
  it("maps browser capture names without showing device or browser error details", () => {
    expect(
      captureError(
        new DOMException("private device diagnostic", "NotAllowedError"),
        "microphone",
      ),
    ).toEqual(message("media.microphoneDenied"));
    expect(
      captureError(
        new DOMException("private device diagnostic", "NotFoundError"),
        "camera",
      ),
    ).toEqual(message("media.cameraMissing"));
    expect(
      captureError(
        new DOMException("private device diagnostic", "NotReadableError"),
        "camera",
      ),
    ).toEqual(message("media.cameraBusy"));
    expect(
      captureError(
        new DOMException("private device diagnostic", "OverconstrainedError"),
        "microphone",
      ),
    ).toEqual(message("media.microphoneUnavailable"));
    expect(
      captureError(new Error("private browser diagnostic"), "screen_video"),
    ).toEqual(message("media.screenFailed"));
  });

  it("retains media failure classification while rendering a safe local message", () => {
    const failure = new MediaError({
      kind: "action_restricted",
      restriction: "camera",
    });
    expect(failure.outcome).toEqual({
      kind: "action_restricted",
      restriction: "camera",
    });
    expect(mediaErrorMessage(failure)).toEqual(
      message("media.cameraRestricted"),
    );
    expect(mediaErrorMessage(new Error("private provider diagnostic"))).toEqual(
      message("media.actionFailed"),
    );
  });
});
