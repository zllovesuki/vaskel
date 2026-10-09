import type { AttachmentOutcome } from "@vaskel/contracts/attachments";
import type { Principal } from "@/server/domain/principal";
import type { ownerStub } from "@/server/directory/owners";
import { storageObservation } from "@/server/actors/shared/attachments/types";

type Owner = Pick<
  ReturnType<typeof ownerStub>,
  "beginAttachmentUpload" | "completeAttachmentUpload"
>;
type RefreshPrincipal = () => Promise<Principal | null>;

/** One authenticated request wins one private writer; no bytes enter the owner. */
export async function uploadAttachment(
  request: Request,
  bucket: {
    put(
      key: string,
      value: ReadableStream,
      options: R2PutOptions,
    ): Promise<R2Object | null>;
  },
  owner: Owner,
  principal: Principal,
  fileId: string,
  refreshPrincipal: RefreshPrincipal,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<AttachmentOutcome> {
  const begun = await owner.beginAttachmentUpload(principal, fileId);
  if (begun.kind !== "attachment_upload") return begun;
  const upload = begun.upload;
  const suppliedLength = request.headers.get("Content-Length");
  if (
    !request.body ||
    (suppliedLength !== null &&
      (!/^\d+$/.test(suppliedLength) ||
        Number(suppliedLength) !== upload.byteLength))
  ) {
    await owner.completeAttachmentUpload(principal, upload, {
      kind: "not_started",
    });
    return { kind: "integrity_mismatch" };
  }
  const aborter = new AbortController();
  const abortRequest = () => aborter.abort(request.signal.reason);
  request.signal.addEventListener("abort", abortRequest, { once: true });
  if (request.signal.aborted) abortRequest();
  const fixed = new FixedLengthStream(upload.byteLength);
  let observed = 0;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed += chunk.byteLength;
        if (observed > upload.byteLength)
          throw new Error("Attachment length exceeded");
        controller.enqueue(chunk);
      },
      flush() {
        if (observed !== upload.byteLength)
          throw new Error("Attachment length mismatch");
      },
    }),
  );
  const pumped = counted
    .pipeTo(fixed.writable, { signal: aborter.signal })
    .then(
      () => true,
      () => false,
    );
  const work = (async (): Promise<AttachmentOutcome> => {
    const stored = await bucket
      .put(upload.objectKey, fixed.readable, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          fileId: upload.fileId,
          generation: upload.generation,
        },
      })
      .then(
        (object) => ({ ok: true as const, object }),
        () => ({ ok: false as const }),
      );
    if (!stored.ok) {
      aborter.abort();
      await owner.completeAttachmentUpload(null, upload, { kind: "uncertain" });
      return { kind: "attachment_not_ready" };
    }
    const object = stored.object;
    if (!object) {
      aborter.abort();
      await owner.completeAttachmentUpload(null, upload, { kind: "uncertain" });
      return { kind: "integrity_mismatch" };
    }
    const intact = await pumped;
    let fresh: Principal | null = null;
    let refreshFailure: { error: unknown } | undefined;
    if (intact && !aborter.signal.aborted) {
      try {
        fresh = await refreshPrincipal();
        if (
          fresh?.userId !== principal.userId ||
          fresh.sessionId !== principal.sessionId
        )
          fresh = null;
      } catch (error) {
        refreshFailure = { error };
      }
    }
    const outcome = await owner.completeAttachmentUpload(fresh, upload, {
      kind: "stored",
      object: storageObservation(object),
    });
    if (refreshFailure) throw refreshFailure.error;
    return intact ? outcome : { kind: "integrity_mismatch" };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<"interrupted">((resolve) => {
    timer = setTimeout(
      () => {
        aborter.abort();
        resolve("interrupted");
      },
      Math.max(1, upload.expiresAt - Date.now()),
    );
    void pumped.then((intact) => {
      if (!intact) resolve("interrupted");
    });
  });
  try {
    const result = await Promise.race([work, interrupted]);
    if (result !== "interrupted") return result;
    // Aborting a stream does not prove the external PUT stopped. Its result may arrive later.
    await owner.completeAttachmentUpload(null, upload, { kind: "uncertain" });
    waitUntil(work);
    return {
      kind:
        Date.now() >= upload.expiresAt
          ? "attachment_expired"
          : "integrity_mismatch",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", abortRequest);
  }
}
