import { fieldHintStyles } from "@vaskel/ui/components/control-styles";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { previewMessageSound, useMessageSounds } from "./message-sounds";

/** A device choice kept in this browser; it needs neither the server nor a connection. */
export function MessageSounds() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useMessageSounds();
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-ui">
      <input
        type="checkbox"
        role="switch"
        className="mt-1 size-4 shrink-0 accent-accent"
        checked={enabled}
        onChange={(event) => {
          setEnabled(event.target.checked);
          // The click also lets this tab start audio.
          if (event.target.checked) previewMessageSound();
        }}
      />
      <span className="min-w-0">
        <span className="block font-medium">
          {t("notifications.messageSoundsToggle")}
        </span>
        <span className={fieldHintStyles}>
          {t("notifications.messageSoundsHint")}
        </span>
      </span>
    </label>
  );
}
