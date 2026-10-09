import { transcript } from "./transcript";

function Fold({ count }: { count: number }) {
  return (
    <p className="out dim">
      … +{count} lines <span className="dim">(ctrl+o to expand)</span>
    </p>
  );
}

/** The person's terminal while their agent follows the file. */
export function Session() {
  return (
    <div
      className="console"
      role="region"
      aria-label="A coding agent's terminal session following INSTALL.md, from the first request to the bootstrap link."
    >
      <div className="console-bar">wren@mbp — claude — ~/loft</div>
      <div className="console-body">
        {transcript.map((turn, index) => {
          if (turn.kind === "you")
            return (
              <p key={index} className="you">
                <span aria-hidden="true">&gt; </span>
                {turn.text}
              </p>
            );
          if (turn.kind === "said")
            return (
              <p key={index} className="said">
                <span aria-hidden="true">● </span>
                {turn.text}
              </p>
            );
          const [first, ...rest] = turn.output;
          return (
            <div key={index}>
              <p className="tool">
                <span aria-hidden="true">● </span>
                <b>{turn.tool}</b>({turn.input})
              </p>
              <p className="out lead">
                <span aria-hidden="true">{"⎿  "}</span>
                {first}
              </p>
              {rest.map((line) => (
                <p key={line} className="out">
                  {line}
                </p>
              ))}
              {turn.more && <Fold count={turn.more} />}
            </div>
          );
        })}
        <div className="console-input" aria-hidden="true">
          <span>&gt;</span>
        </div>
        <p className="console-hint" aria-hidden="true">
          ? for shortcuts
        </p>
      </div>
    </div>
  );
}
