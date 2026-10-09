export function Footer() {
  return (
    <footer className="wrap flex flex-wrap items-center justify-between gap-x-7 gap-y-3 pt-8 pb-10 text-ui">
      <span
        className="text-[1.45rem] leading-none font-bold tracking-[-0.06em] text-ink [&>span]:text-accent"
        aria-hidden="true"
      >
        vaskel<span>.</span>
      </span>
      <nav
        aria-label="Footer"
        className="ml-auto flex flex-wrap justify-end gap-x-7 gap-y-3"
      >
        <a href="https://github.com/zllovesuki/vaskel" className="text-ink">
          Source on GitHub
        </a>
        <a href="/INSTALL.md" className="text-ink">
          INSTALL.md
        </a>
      </nav>
    </footer>
  );
}
