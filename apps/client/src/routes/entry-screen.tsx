import { lazy, Suspense } from "react";
import { Navigate } from "@tanstack/react-router";
import { SignInForm } from "@/client/features/auth/sign-in";
import { useOptionalUser } from "@/client/features/auth/session-state";
import { useRoutePage } from "@/client/routes/route-page";
import { WorkspaceSkeleton } from "@/client/ui/workspace-skeleton";

const Workspace = lazy(() =>
  import("@/client/features/workspace/workspace").then((module) => ({
    default: module.Workspace,
  })),
);

export function EntryScreen() {
  const user = useOptionalUser();
  const page = useRoutePage();
  if (!user && page === "home")
    return <Navigate to="/sign-in" search={{}} replace />;
  return !user ? (
    <SignInForm key={page} returnToResource />
  ) : (
    <Suspense fallback={<WorkspaceSkeleton fill />}>
      <Workspace />
    </Suspense>
  );
}
