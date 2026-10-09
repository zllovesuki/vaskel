import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { InviteRegistrationResponseSchema } from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { expect, password, type BrowserApplication } from "@tests/e2e/fixtures";

export async function invitation(app: BrowserApplication) {
  const created = AdministrationOutcomeSchema.parse(
    (
      await app.request(
        app.owner,
        `/api/servers/${app.circle.owner.id}/invites`,
        { expiresAt: Date.now() + 3_600_000, maxUses: 1 },
      )
    ).result,
  );
  if (created.kind !== "invite_created")
    throw new Error("Entry fixture invitation failed");
  return created.token;
}

/** A new invited account whose verification link has not been opened. */
export async function unverified(app: BrowserApplication) {
  const email = `entry-${randomUUID()}@browser.invalid`;
  const registration = InviteRegistrationResponseSchema.parse(
    (
      await app.request(null, "/api/invites/register", {
        token: await invitation(app),
        registrationId: randomUUID(),
        email,
        displayName: "Entry Member",
        password,
      })
    ).result,
  );
  expect(registration).toMatchObject({ status: "registered" });
  return app.mailedToken("verify-email", email);
}

export async function fitsPhone(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
}
