import { readDeviceChoices } from "@/client/features/media/devices";

export class AudioOutput {
  private readonly elements = new Set<HTMLMediaElement>();
  apply(deafened: boolean) {
    const speaker = readDeviceChoices().speaker;
    for (const element of this.elements) {
      element.muted = deafened;
      const sink = element as HTMLMediaElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (sink.setSinkId) void sink.setSinkId(speaker ?? "").catch(() => {});
    }
  }
  register(element: HTMLMediaElement, deafened: boolean) {
    this.elements.add(element);
    this.apply(deafened);
    return () => {
      this.elements.delete(element);
    };
  }
  play() {
    return Promise.allSettled(
      [...this.elements].map((element) => element.play()),
    );
  }
  clear() {
    this.elements.clear();
  }
}
