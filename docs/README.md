# Documentation

To host vaskel, start with [installation](../INSTALL.md), then
[operations](operations.md) and [costs](costs.md).
For local setup and checks, use the [development guide](../IMPLEMENTATION.md).
[Release preparation](readiness.md) lists open decisions and remaining checks.

## Topics

| Topic                                       | Guide                                                   |
| ------------------------------------------- | ------------------------------------------------------- |
| Product scope and privacy                   | [Product](../PRODUCT.md), [policies](product-review.md) |
| Architecture and state ownership            | [Architecture](architecture.md)                         |
| Accounts, invitations and permissions       | [Access](access.md)                                     |
| Messages, quotes and search                 | [Messaging](messaging.md)                               |
| Sockets, presence, unread and replay        | [Synchronization](synchronization.md)                   |
| Browser notifications                       | [Notifications](notifications.md)                       |
| Uploads, downloads and file deletion        | [Attachments](attachments.md)                           |
| Client state, startup and request lifetimes | [Frontend](frontend.md)                                 |
| Saved history, drafts and offline use       | [Client storage](client-storage.md)                     |
| Layout and interaction                      | [Lounge design](frontend-design.md)                     |
| Languages and text input                    | [Internationalization](internationalization.md)         |
| Calls and device switching                  | [Media](media.md)                                       |
| SFU negotiation and cleanup                 | [Media transport](media-transport.md)                   |
| SQL, migrations and build boundaries        | [Engineering](engineering.md)                           |
| Browser test setup                          | [Browser acceptance](../tests/e2e/README.md)            |
| The vaskel.com website                      | [Site design](../apps/site/DESIGN.md)                   |

[sources.json](sources.json) records external references and reviewed revisions.
