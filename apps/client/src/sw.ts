import { PrecacheController } from "workbox-precaching/PrecacheController.js";
import { PrecacheRoute } from "workbox-precaching/PrecacheRoute.js";
import { NavigationRoute } from "workbox-routing/NavigationRoute.js";
import { registerRoute } from "workbox-routing/registerRoute.js";
import { applicationRouteTemplates } from "@/client/routes/application-paths";
import { shellContentTypes } from "@/client/service-worker/assets";
import {
  openNotification,
  receiveNotification,
} from "@/client/service-worker/notifications";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("push", (event) => {
  event.waitUntil(
    receiveNotification(event.data, self.registration, self.navigator),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    openNotification(
      event.notification.data,
      self.location.origin,
      self.clients,
    ),
  );
});
const controller = new PrecacheController({
  cacheName: "vaskel-precache",
  plugins: [
    {
      async cacheWillUpdate({ request, response }) {
        const types = shellContentTypes(new URL(request.url).pathname);
        const type = response.headers
          .get("Content-Type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        return response.ok && type && types?.includes(type) ? response : null;
      },
    },
  ],
});
controller.strategy.fetchOptions = { credentials: "omit", cache: "reload" };
// A complete update waits until an application tab requests activation.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});
controller.precache(self.__WB_MANIFEST);
registerRoute(
  new PrecacheRoute(controller, {
    cleanURLs: false,
    directoryIndex: "",
    ignoreURLParametersMatching: [],
  }),
);
const navigation = new NavigationRoute(
  controller.createHandlerBoundToURL("/"),
  {
    allowlist: applicationRouteTemplates.map(
      (path) =>
        new RegExp(
          `^${path
            .split("/")
            .map((segment) =>
              segment.startsWith("$")
                ? "[^/?]+"
                : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            )
            .join("/")}/*$`,
        ),
    ),
  },
);
registerRoute(
  (options) =>
    options.sameOrigin && !options.url.search && navigation.match(options),
  navigation.handler,
);
