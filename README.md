# vaskel.

vaskel. is a place for your group to chat, call and share screens. It runs in
the browser, on a Cloudflare instance you host. People join by invitation.

Drop into a voice room, show what you're working on, or keep a game-night
conversation going while you browse the chat. Calls stay with you as you move
between rooms.

Built with [GPT-6 Astra](https://openai.com/index/gpt-6-astra/).

## Room for your group

Organize conversations into **circles**, with text and voice **rooms** inside
each one. Keep a room private when it needs a smaller audience. One account
works across the instance, and direct messages stay with you across circles.

Share files, quote a message into another conversation, or search for something
you remember. Saved drafts survive a reload. Read cached history offline,
then reconnect when you're ready to send.

The interface is available in English, Simplified Chinese, Traditional Chinese
and Japanese. You can get a feel for it at [vaskel.com](https://vaskel.com).

## Start your own

Give your coding agent this request:

> Set up vaskel. using https://vaskel.com/INSTALL.md. Guide me through any prerequisites.

You'll need your own Cloudflare account, a Workers paid plan and a domain. Your
agent walks you through the app address, email delivery and call setup, then
hands you a link to create the host account. From there, create a circle and
invite someone.

The [installation guide](INSTALL.md) has the full procedure. Our
[small-group cost example](docs/costs.md) budgets about **US$5–10 a month**.
Your bill depends on usage, especially video and screen sharing.

## Working on vaskel

The [development guide](IMPLEMENTATION.md) covers local setup and checks.
[Architecture](docs/architecture.md) explains how the app fits together, and the
[documentation index](docs/README.md) links the feature guides.

## License

vaskel-owned code is available under the [MIT license](LICENSE). Dependencies
retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
