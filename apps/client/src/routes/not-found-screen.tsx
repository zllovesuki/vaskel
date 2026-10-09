import { Link } from "@tanstack/react-router";
import { useI18n } from "@/client/features/i18n/use-i18n";
import {
  buttonStyles,
  emptyStateStyles,
} from "@vaskel/ui/components/control-styles";
export function NotFoundScreen() {
  const { t } = useI18n();
  return (
    <main className={emptyStateStyles}>
      <h1>{t("routes.notFound")}</h1>
      <Link to="/" search={{}} className={buttonStyles()}>
        {t("routes.return")}
      </Link>
    </main>
  );
}
