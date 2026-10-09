import { useEffect, useRef } from "react";
import { useMediaController } from "./context";

export function MediaPlayback({
  stream,
  audio = false,
  label,
  local = false,
}: {
  stream: MediaStream;
  audio?: boolean;
  label: string;
  local?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const sound = useRef<HTMLAudioElement>(null);
  const controller = useMediaController();
  useEffect(() => {
    const element = audio ? sound.current : video.current;
    if (!element) return;
    element.srcObject = stream;
    const unregister = audio ? controller.registerAudio(element) : undefined;
    void element.play().catch(() => {
      if (audio) controller.playbackFailed();
    });
    return () => {
      unregister?.();
      element.pause();
      element.srcObject = null;
    };
  }, [audio, controller, stream]);
  return audio ? (
    <audio ref={sound} autoPlay aria-label={label} />
  ) : (
    <video
      ref={video}
      autoPlay
      playsInline
      muted={local || !audio}
      aria-label={label}
      className="aspect-video w-full rounded-lg bg-stage-raised object-contain"
    />
  );
}
