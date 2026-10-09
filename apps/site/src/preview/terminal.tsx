/** s0ren's shared screen: a terminal window, as DOM text rather than a raster. */
export function Terminal() {
  return (
    <div className="termw">
      <div className="termbar">soren@mbp — zsh — ~/garden-bot</div>
      <pre className="term">
        <span className="p">~/garden-bot</span>{" "}
        <span className="dim">(main)</span> $ pnpm test{"\n"}
        <span className="ok">✓</span> scheduler/water.test.ts{" "}
        <span className="dim">(14)</span>
        {"\n"}
        <span className="ok">✓</span> sensors/soil.test.ts{" "}
        <span className="dim">(9)</span>
        {"\n"}
        <span className="ok">✓</span> telegram/notify.test.ts{" "}
        <span className="dim">(6)</span>
        {"\n\n"}
        {" Test Files  "}
        <span className="ok">3 passed</span> <span className="dim">(3)</span>
        {"\n"}
        {"      Tests  "}
        <span className="ok">29 passed</span> <span className="dim">(29)</span>
        {"\n"}
        {"   Duration  1.84s"}
        {"\n\n"}
        <span className="p">~/garden-bot</span>{" "}
        <span className="dim">(main)</span> $ git push origin main{"\n"}
        <span className="dim">
          To github.com:s0ren/garden-bot.git{"\n"} 3f674c5..a1b2c3d main -&gt;
          main
        </span>
        {"\n"}
        <span className="p">~/garden-bot</span>{" "}
        <span className="dim">(main)</span> ${" "}
      </pre>
    </div>
  );
}
