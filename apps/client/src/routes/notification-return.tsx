import { Link, Navigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  buttonStyles,
  emptyStateStyles,
} from "@vaskel/ui/components/control-styles";
import { SignInForm } from "@/client/features/auth/sign-in";
import { useOptionalUser } from "@/client/features/auth/session-state";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { NotFoundScreen } from "./not-found-screen";
import { notificationReturnDecision } from "./notification-target";

export function NotificationReturn() {
  const params = useParams({ strict: false });
  const user = useOptionalUser();
  const { t } = useI18n();
  const decision = notificationReturnDecision(
    {
      accountId: params.accountId,
      owner: params.ownerKind
        ? { kind: params.ownerKind, id: params.ownerId }
        : null,
      roomId: params.channelId ?? null,
    },
    user?.userId ?? null,
  );
  useEffect(() => {
    if (decision.kind === "open") {
      // Returning clears the activity dot; ordinary timeline rules own read state.
      void navigator.clearAppBadge?.().catch(() => undefined);
    }
  }, [decision.kind]);
  if (decision.kind === "invalid") return <NotFoundScreen />;
  if (decision.kind === "sign-in") return <SignInForm returnToResource />;
  if (decision.kind === "open")
    return <Navigate {...decision.location} search={{}} replace />;
  return (
    <main className={emptyStateStyles}>
      <h1>{t("notifications.otherAccountTitle")}</h1>
      <p>{t("notifications.otherAccountBody")}</p>
      <Link to="/" search={{}} className={buttonStyles()}>
        {t("routes.return")}
      </Link>
    </main>
  );
}
