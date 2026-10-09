import { INLINE_SIGNATURE_BYTES } from "@vaskel/contracts/attachments";
import { detectRasterContentType } from "./raster-image";

export type PreviewState =
  | { phase: "idle" | "loading" | "unsupported" | "unavailable" }
  | { phase: "decoding" | "ready"; url: string };
const initialState: PreviewState = { phase: "idle" };

/** One mounted local preview owns one object URL; a superseded load publishes nothing. */
export class PreviewResource {
  private state: PreviewState = initialState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private url: string | null = null;
  getSnapshot = () => this.state;
  getServerSnapshot = () => initialState;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: PreviewState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private retire() {
    this.generation++;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
  async load(file: Blob) {
    this.retire();
    const generation = this.generation;
    this.publish({ phase: "loading" });
    try {
      const bytes = new Uint8Array(
        await file.slice(0, INLINE_SIGNATURE_BYTES).arrayBuffer(),
      );
      if (generation !== this.generation) return;
      const contentType = detectRasterContentType(bytes);
      if (!contentType) {
        this.publish({ phase: "unsupported" });
        return;
      }
      // Neither an extension nor File MIME can make document bytes inline.
      this.url = URL.createObjectURL(file.slice(0, file.size, contentType));
      this.publish({ phase: "decoding", url: this.url });
    } catch {
      if (generation === this.generation)
        this.publish({ phase: "unavailable" });
    }
  }
  decoded(url: string) {
    if (this.url === url) this.publish({ phase: "ready", url });
  }
  failed(url: string) {
    if (this.url !== url) return;
    this.retire();
    this.publish({ phase: "unavailable" });
  }
  dispose() {
    this.retire();
    this.publish(initialState);
  }
}
