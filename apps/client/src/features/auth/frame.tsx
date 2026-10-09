import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  buttonStyles,
  noticeStyles,
} from "@vaskel/ui/components/control-styles";
import { Avatar } from "@vaskel/ui/components/avatar";
import {
  publicInstanceOptions,
  INSTANCE_ICON_PATH,
} from "@/client/api/instance";
import { errorMessage } from "@/client/api/client";
import { useI18n } from "@/client/features/i18n/use-i18n";
import { NotificationCleanupNotice } from "@/client/features/notifications/cleanup-notice";
import { PendingLabel } from "@/client/ui/loading-skeleton";
import { useOptionalUser } from "./session-state";

const DEFAULT_INSTANCE_NAME = "vaskel.";
const markStyles = "font-bold tracking-[-0.06em] text-ink";

/** The product mark: the full stop carries the accent. */
function Mark({ className = "" }: { className?: string }) {
  return (
    <span className={`${markStyles} ${className}`}>
      vaskel
      <span aria-hidden="true" className="text-accent">
        .
      </span>
    </span>
  );
}

/**
 * Who this door belongs to. A named vaskel. leads with its own icon and name
 * over a small product mark; the default name shows the mark once.
 */
function Identity({
  instance,
}: {
  instance: { name: string; hasIcon: boolean } | undefined;
}) {
  const { t } = useI18n();
  if (!instance) return <div className="mb-8 min-h-12" aria-hidden="true" />;
  if (instance.name === DEFAULT_INSTANCE_NAME)
    return (
      <div className="mb-8">
        <p className="text-[2rem] leading-none">
          <Mark />
        </p>
        <p className="mt-3 text-ui leading-relaxed text-muted">
          {t("auth.tagline")}
        </p>
      </div>
    );
  // Every catalog keeps the literal product name inside this sentence.
  const [before, after] = t("auth.onVaskel").split(DEFAULT_INSTANCE_NAME);
  return (
    <div className="mb-8 flex items-center gap-3.5">
      {instance.hasIcon ? (
        <img
          src={INSTANCE_ICON_PATH}
          alt=""
          className="size-12 shrink-0 rounded-[30%] border border-line object-cover"
        />
      ) : (
        <Avatar name={instance.name} size={12} className="border border-line" />
      )}
      <div className="min-w-0">
        <p className="text-[1.25rem] leading-tight font-semibold wrap-anywhere">
          {instance.name}
        </p>
        <p className="mt-1 text-caption text-muted">
          {after === undefined ? (
            before
          ) : (
            <>
              {before}
              <Mark />
              {after}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function AuthFrame({
  title,
  description,
  descriptionRole,
  focusKey,
  children,
}: {
  title: string;
  description?: ReactNode;
  descriptionRole?: "alert";
  focusKey?: string | null;
  children: ReactNode;
}) {
  const instance = useQuery(publicInstanceOptions());
  const heading = useRef<HTMLHeadingElement>(null);
  // A completed submission moves focus; a first visit leaves browser focus alone.
  useEffect(() => {
    if (focusKey) heading.current?.focus();
  }, [focusKey]);
  return (
    <main className="flex min-h-svh flex-col bg-page p-6 sm:px-12 sm:py-8">
      <NotificationCleanupNotice className="-mx-6 -mt-6 sm:-mx-12 sm:-mt-8" />
      <section
        className="m-auto w-full max-w-[25rem] py-10 sm:py-16"
        aria-labelledby="auth-title"
      >
        <Identity instance={instance.data} />
        <h1
          ref={heading}
          tabIndex={-1}
          className="mb-4 text-balance focus-visible:outline-none"
          id="auth-title"
        >
          {title}
        </h1>
        {description && (
          <p
            className="mb-7 leading-relaxed text-pretty wrap-anywhere text-muted"
            role={descriptionRole}
          >
            {description}
          </p>
        )}
        {children}
      </section>
    </main>
  );
}

export function EntryError({ error }: { error: unknown }) {
  const { text } = useI18n();
  return error ? (
    <p role="alert" className={noticeStyles({ error: true })}>
      {text(errorMessage(error))}
    </p>
  ) : null;
}

export function EntryNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className={noticeStyles()}>
      {children}
    </p>
  );
}

export function EntrySubmit({
  pending,
  disabled = false,
  children,
}: {
  pending: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <button
      className={buttonStyles({ variant: "primary" })}
      disabled={pending || disabled}
    >
      <PendingLabel pending={pending} label={t("auth.pleaseWait")}>
        {children}
      </PendingLabel>
    </button>
  );
}

/** Finished and unusable entry steps retain one way forward. */
export function EntryExit({ done = false }: { done?: boolean }) {
  const user = useOptionalUser();
  const { t } = useI18n();
  return (
    <div
      className={done ? "flex flex-col" : "mt-2 flex flex-wrap items-center"}
    >
      <Link
        to={user ? "/" : "/sign-in"}
        search={{}}
        className={buttonStyles({ variant: done ? "primary" : "default" })}
      >
        {user ? t("routes.return") : t("auth.signIn")}
      </Link>
    </div>
  );
}
