# Install vaskel. on your own Cloudflare account

Give your coding agent this request:

> Set up vaskel. using https://vaskel.com/INSTALL.md. Guide me through any prerequisites.

The person chooses an app address, signs in when prompted, approves any purchase
and verifies their email. The agent handles the tools, configuration and
deployment. One instance serves the browser app, every circle and all direct
messages.

These instructions target **v0.1.0**. If that tag is not available yet, report
that the release has not been published; do not substitute a development branch.
To upgrade a working instance, follow the
[upgrade procedure](https://github.com/zllovesuki/vaskel/blob/release/docs/operations.md#upgrades-and-supported-tooling)
instead of starting a fresh installation. To resume unfinished setup, continue
from its existing state below.

## Working with the person

Ask only for missing choices or actions that require the person: the Cloudflare
account, their preferred app address, a sending email address, sign-in and
purchase approval. Help choose an address if they do not have one. Explain these
as the website they will visit and the address their verification and password-reset
emails will come from; do not ask them for binding names or database IDs.

Use only their account and resources. Replace the maintainer account IDs and
hostnames in the repository. The account needs a Workers paid plan and an active
domain on Cloudflare. If either is missing, guide the person through enabling
the plan or connecting a domain. Confirm any new plan or domain purchase before
buying it; usage beyond included allowances is billed separately.

Never put `AUTH_SECRET`, `REALTIME_APP_SECRET` or a secrets file's contents into
chat, commands shown to the person, or logs. The setup key is the exception:
deliver it separately from the bootstrap URL. Keep secrets out of Git.

When resuming, use the existing checkout, recorded resource IDs and secrets.
Inspect the last step's result before repeating it. A failed build or deployment
does not call for new databases, buckets or credentials. If something is missing,
explain the specific action needed to continue.

If deployment already succeeded, start with [Hand over the app](#hand-over-the-app).
Return to earlier steps only to fix a failed check or complete missing setup.

## Prepare

1. Check Git, Node 24.14 or newer and the pnpm version pinned in `package.json`
   (11.1.0 for this release). Help install missing tools. For a new installation:

   ```sh
   git clone --branch v0.1.0 https://github.com/zllovesuki/vaskel.git vaskel
   cd vaskel
   git switch -c instance
   pnpm install --frozen-lockfile --ignore-scripts
   ```

   For an interrupted installation, enter its existing checkout and retain its
   branch and configuration. Run the locked install if dependencies are missing.
   All later commands run from that checkout's root. A hosted Git repository is
   optional; the local branch is enough to install and retain configuration.

2. Check Wrangler's Cloudflare sign-in:

   ```sh
   pnpm exec wrangler whoami
   ```

   If it reports no login, run `pnpm exec wrangler login --device --no-browser`
   and give the person the approval URL and one-time code. They can approve from
   another device; the agent's machine does not need a browser. If more than one
   account is listed, ask which account to use by name. Record the selected
   account's ID for later commands.
   Agree on the exact app origin (such as `https://chat.example.org`) and sender
   (such as `vaskel@example.org`).

3. Set up the [Cloudflare CLI](https://developers.cloudflare.com/cf/get-started/)
   (`cf`) for email and voice/video calls. Run `cf --version`; if it is missing
   or reports a different version, install `1.0.0-beta.13`:

   ```sh
   npm install --global --ignore-scripts cf@1.0.0-beta.13
   ```

   Run `cf auth whoami`. Continue when `authenticated` and `tokenValid` are
   `true`. If it reports no login or an invalid token, run
   `cf auth login --no-browser` and give the person its URL and one-time code.
   Explain the separate approval briefly:

   > Cloudflare requires a separate approval for the tool that sets up email and
   > calls. Please use the same Cloudflare account as before.

   `cf` does not read Wrangler's account selection. In each resource command
   and the SFU script below, replace `ACCOUNT_ID` with the ID recorded in step 2.
   The prefix supplies it even when commands run in separate shells.

4. Configure the sending domain through
   [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/).
   Use the part of the sender address after `@` for `--name` and its Cloudflare
   zone for `--zone`. For `vaskel@example.org`, both are `example.org`. For
   `vaskel@mail.example.org`, the name is `mail.example.org` and the zone is
   `example.org`. These commands use the first example:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" cf email-sending subdomains list --zone example.org
   ```

   If the list contains the sender's domain with `enabled: true`, reuse that
   entry. Otherwise create it; this also re-enables a disabled sending domain:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" cf email-sending subdomains create --zone example.org --name example.org
   ```

   Cloudflare adds the required sending DNS records automatically. Take `tag`
   from the selected list entry or the create response and substitute it for
   `SENDING_DOMAIN_ID` to check their status:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" cf email-sending subdomains dns status "SENDING_DOMAIN_ID" --zone example.org
   ```

   Continue when `status` is `ready`. For `unconfigured` or `unlocked`, use
   Cloudflare's fix command, then check the status again:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" cf email-sending subdomains dns fix "SENDING_DOMAIN_ID" --zone example.org
   ```

   For `misconfigured`, read `errors`. The same fix command handles missing or
   unlocked records. If resolving a conflict would change the person's existing
   mail setup, explain that change and ask before proceeding. If records have
   been applied but DNS is still propagating, wait and repeat the status check;
   explain the wait to the person. The app and sender can use the same domain.

5. Create or reuse their
   [Realtime SFU app](https://developers.cloudflare.com/realtime/sfu/get-started/)
   for calls. When resuming, reuse this installation's app ID from the production
   configuration in `apps/server/wrangler.jsonc` and its saved or deployed
   secret. To find an existing app, use:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" cf realtime sfu apps list
   ```

   For a new app, this script captures the CLI response, saves the secret and
   prints only the app ID:

   ```sh
   CLOUDFLARE_ACCOUNT_ID="ACCOUNT_ID" node --input-type=module <<'NODE'
   import { execFileSync } from "node:child_process";
   import { existsSync, mkdirSync, writeFileSync } from "node:fs";
   const secretFile = ".local/install/realtime-secret";
   if (existsSync(secretFile)) throw new Error("An SFU secret already exists; reuse its app instead of creating another");
   mkdirSync(".local/install", { recursive: true, mode: 0o700 });
   const app = JSON.parse(execFileSync("cf", ["realtime", "sfu", "apps", "create", "--name", "vaskel"], { encoding: "utf8" }));
   writeFileSync(secretFile, app.secret, { mode: 0o600, flag: "wx" });
   console.log("REALTIME_APP_ID=" + app.uid);
   NODE
   ```

   Record the printed app ID using the configuration table in
   [Configure and deploy](#configure-and-deploy). Keep
   `.local/install/realtime-secret`; step 3 of that section uses it to generate
   `secrets.json`. Later app retrieval does not return the secret.

   For an existing app, use the secrets table in Configure and deploy step 3.
   Request its secret only if it is absent from the saved secret files and the
   deployed Worker. If the agent provides a private credential-entry field,
   use it. Otherwise create `.local/install/` with mode `0700`. If
   `.local/install/realtime-secret` is missing, create an empty file with mode
   `0600`. Let the person paste the secret into it. They do not need to set
   environment variables or send the secret in chat. Git ignores these paths.

## Configure and deploy

1. Edit `env.production` in `apps/server/wrangler.jsonc`. Fill these values from
   the choices above:

   | Field                     | Value                                                  |
   | ------------------------- | ------------------------------------------------------ |
   | `account_id`              | The selected Cloudflare account ID                     |
   | `name`                    | An available Worker name, normally `vaskel-production` |
   | `routes[0].pattern`       | App hostname only, such as `chat.example.org`          |
   | `routes[0].custom_domain` | Keep `true`                                            |
   | `vars.AUTH_ORIGIN`        | Exact HTTPS app origin, without a trailing slash       |
   | `vars.MAIL_FROM`          | The sender on the verified sending domain              |
   | `vars.REALTIME_APP_ID`    | The selected SFU app ID                                |

   Keep `vars.PUSH_VAPID_SUBJECT` blank to use the app's origin. For a new
   installation, assign four distinct numeric rate-limit namespace IDs not used
   by its other Workers; record and reuse them on resume. Keep the existing
   limits, Durable Object classes, bindings and migration declarations.

2. Check the account's resources before creating anything:

   ```sh
   pnpm exec wrangler d1 list --config apps/server/wrangler.jsonc --env production
   pnpm exec wrangler r2 bucket list --config apps/server/wrangler.jsonc --env production
   pnpm exec wrangler queues list --config apps/server/wrangler.jsonc --env production
   ```

   Reuse this installation's recorded resources. A matching name alone does not
   identify a resource as belonging to this installation. For a new installation,
   use the names below if available; otherwise choose a distinct set and use it
   consistently. Run **only** the commands for missing resources:

   ```sh
   pnpm exec wrangler d1 create vaskel-identity-production --config apps/server/wrangler.jsonc --env production
   pnpm exec wrangler r2 bucket create vaskel-attachments-production --config apps/server/wrangler.jsonc --env production
   pnpm exec wrangler queues create vaskel-push-production --config apps/server/wrangler.jsonc --env production
   ```

   Save the returned D1 ID as `database_id` on the `IDENTITY_DB` production
   binding in `d1_databases`, alongside its `database_name`. On the `r2_buckets`
   entry whose binding is `ATTACHMENTS`, set `bucket_name` to the private bucket's
   name. Set both `queues.producers` (`PUSH_QUEUE`) and
   `queues.consumers` to the same Queue name. Leave R2 public access disabled.

3. Choose the secrets path from the existing state before running generation:

   | State                                                    | Action                                                                                                        |
   | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
   | `.local/install/secrets.json` exists                     | Reuse it; skip generation.                                                                                    |
   | Worker was already deployed, but the local file is gone  | List its remote secret names with the command below. Preserve them and omit `--secrets-file` on redeployment. |
   | New installation with neither local nor deployed secrets | Generate once using the supplied SFU secret.                                                                  |

   ```sh
   pnpm exec wrangler secret list --config apps/server/wrangler.jsonc --env production
   ```

   A deployed Worker needs `AUTH_SECRET`, `OPERATOR_BOOTSTRAP_SECRET` and
   `REALTIME_APP_SECRET`. Missing credentials require recovery, not regeneration
   of the installation's other secrets. For the new-installation case only, this
   script accepts the secure input as either an environment variable or the file
   prepared above, and never prints it:

   ```sh
   node --input-type=module <<'NODE'
   import { randomBytes } from "node:crypto";
   import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
   const input = ".local/install/realtime-secret";
   const secret = process.env.REALTIME_APP_SECRET?.trim() || readFileSync(input, "utf8").trim();
   if (!secret) throw new Error("The SFU secret has not been supplied");
   mkdirSync(".local/install", { recursive: true, mode: 0o700 });
   writeFileSync(".local/install/secrets.json", JSON.stringify({
     AUTH_SECRET: randomBytes(32).toString("hex"),
     OPERATOR_BOOTSTRAP_SECRET: randomBytes(32).toString("hex"),
     REALTIME_APP_SECRET: secret,
   }), { mode: 0o600, flag: "wx" });
   NODE
   ```

4. Apply identity migrations by binding name:

   ```sh
   pnpm exec wrangler d1 migrations apply IDENTITY_DB --remote --env production --config apps/server/wrangler.jsonc
   ```

   Apply only pending migrations; do not reset existing storage. The unchanged
   release's schema is covered by release validation. If authentication code,
   Better Auth or the identity schema was customized, first run the
   [auth-schema check](https://github.com/zllovesuki/vaskel/blob/v0.1.0/IMPLEMENTATION.md#validation).

   When ready to deploy a new instance, set
   `vars.OPERATOR_BOOTSTRAP_EXPIRES_AT` to an ISO timestamp one hour ahead.
   Save the nonsecret configuration in a local Git commit. If Git has no author
   configured, use repository-local identity `vaskel setup <setup@vaskel.invalid>`
   for this commit; the person does not need a Git hosting account. Then deploy:

   ```sh
   pnpm run deploy:production --secrets-file .local/install/secrets.json
   ```

   If deployment fails, fix that step and retry with the same resources and
   secrets. If resuming an already deployed instance with a host, leave bootstrap
   configuration alone and use the existing remote secrets.

## Hand over the app

1. Check HTTPS and `GET /api/health` at the chosen origin; health must return
   JSON with `status: "ok"`. Check `GET /api/identity/bootstrap` too. It must
   return JSON with `status: "available"` for first-host setup, or
   `status: "complete"` if the host already exists. An HTML page is not an API
   success. For startup errors, inspect
   `pnpm exec wrangler tail --config apps/server/wrangler.jsonc --env production`.

2. If setup is available, give the person the app origin followed by `/bootstrap`
   and provide only the setup key separately. They choose their email, name and
   password, follow the verification email, and sign in. If setup is complete,
   send them to `/sign-in` instead. An expired unused key needs a new expiry and
   redeployment with the same secrets. Missing mail needs delivery repair and
   resend verification, not another host account.

3. After verified host sign-in, installation is complete. Hand over the app URL
   and the location of the configured checkout. Keep the secret files in
   `.local/install/` for future setup or recovery; Git ignores them. If the
   agent's workspace will not remain available, help the person copy the
   checkout, including `.local/install/`, to storage they control. Offer an
   operator-owned private Git repository as an optional backup of everything
   except those secrets, keeping the original repository as `upstream` if they
   choose one.

The host can now create a circle and invite friends. Offer to help try messaging,
attachments, calls and screen sharing, or password recovery; these are follow-up
activities, not steps that delay handing over the installed app. Further
administration is in
[Operations](https://github.com/zllovesuki/vaskel/blob/release/docs/operations.md).
