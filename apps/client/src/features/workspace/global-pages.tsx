import { AccountSettings } from "@/client/features/account/account-settings";
import { NotificationSettings } from "@/client/features/notifications/notification-settings";
import { HostPage } from "@/client/features/host/host-page";
import { BlockedPeople } from "@/client/features/blocking/blocked-people";
import { SearchPanel } from "@/client/features/search/search-panel";
import { useWorkspace } from "./context";

export function AccountPage() {
  const { openNavigation } = useWorkspace();
  return <AccountSettings onNavigation={openNavigation} />;
}
export function NotificationsPage() {
  const { openNavigation } = useWorkspace();
  return <NotificationSettings onNavigation={openNavigation} />;
}
export function InstancePage() {
  const { openNavigation } = useWorkspace();
  return <HostPage onNavigation={openNavigation} />;
}
export function BlockedPage() {
  const { openNavigation } = useWorkspace();
  return <BlockedPeople onNavigation={openNavigation} />;
}
export function SearchPage() {
  const {
    navigation: { resources },
    openNavigation,
  } = useWorkspace();
  return <SearchPanel resources={resources} onNavigation={openNavigation} />;
}
