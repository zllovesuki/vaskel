const needs = [
  {
    title: "Cloudflare Workers paid plan",
    detail: "US$5 a month, plus usage.",
    paid: true,
  },
  {
    title: "A domain on Cloudflare",
    detail: (
      <>
        An address for your vaskel., such as <code>chat.example.org</code>.
      </>
    ),
    paid: true,
  },
  {
    title: "An email sender",
    detail: "Use your domain for verification and password-reset mail.",
  },
  {
    title: "Cloudflare Realtime",
    detail: "For voice, camera and screen sharing.",
  },
  {
    title: "A coding agent",
    detail: "With terminal access on your machine.",
  },
];

export function Needs() {
  return (
    <div className="cols">
      <p className="copy">
        One vaskel. can hold several circles, with shared accounts and direct
        messages. Add a circle whenever you need a place for another group.
      </p>
      <ul className="rows" aria-label="What you need">
        {needs.map((need) => (
          <li key={need.title} className="row">
            <span className="lines">
              {need.title}
              <span className="s">{need.detail}</span>
            </span>
            {need.paid && (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 text-fine leading-5 font-semibold text-accent">
                paid
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
