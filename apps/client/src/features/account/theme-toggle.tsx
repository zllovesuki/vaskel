import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { menuItemStyles } from "@vaskel/ui/components/control-styles";
import { useTheme } from "@/client/ui/theme";

const systemQuery = "(prefers-color-scheme: dark)";
const systemDark = () => window.matchMedia(systemQuery).matches;
function subscribeSystem(change: () => void) {
  const query = window.matchMedia(systemQuery);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

/** Device-level appearance switch in the account menu. */
export function ThemeMenuItem({ onSelect }: { onSelect?: () => void }) {
  const { t } = useI18n();
  const [choice, setChoice] = useTheme();
  const prefersDark = useSyncExternalStore(
    subscribeSystem,
    systemDark,
    () => false,
  );
  const dark = choice === "dark" || (choice === "system" && prefersDark);
  return (
    <button
      type="button"
      className={menuItemStyles}
      onClick={() => {
        setChoice(dark ? "light" : "dark");
        onSelect?.();
      }}
    >
      {dark ? (
        <Sun className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Moon className="size-4 shrink-0" aria-hidden="true" />
      )}
      {t(dark ? "account.useLightTheme" : "account.useDarkTheme")}
    </button>
  );
}
