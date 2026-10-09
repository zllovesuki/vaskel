export function Band() {
  return (
    <header className="wrap flex min-h-14 flex-wrap items-center gap-x-5 gap-y-2.5 border-b border-line py-2">
      <a
        href="#top"
        className="text-[1.85rem] leading-none font-bold tracking-[-0.06em] text-ink no-underline [&>span]:text-accent"
        aria-label="vaskel."
      >
        vaskel<span>.</span>
      </a>
      <p className="min-w-0 flex-1 text-chat text-muted max-sm:order-3 max-sm:basis-full">
        A private place for your people, on your own Cloudflare account.
      </p>
      <nav
        aria-label="Primary"
        className="flex items-center gap-3 max-sm:ml-auto"
      >
        <a
          href="https://github.com/zllovesuki/vaskel"
          className="px-1.5 py-2 text-ui font-medium text-ink no-underline hover:underline"
        >
          GitHub
        </a>
        <a
          href="#deploy"
          className="inline-flex min-h-control-tall items-center justify-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2 text-ui font-semibold text-on-accent no-underline transition-colors hover:border-accent-hover hover:bg-accent-hover"
        >
          Deploy your own
        </a>
      </nav>
    </header>
  );
}
