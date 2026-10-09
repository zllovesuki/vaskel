import { scenarios } from "./scenarios";

const usd = (value: number) =>
  value === 0 ? "Included" : value < 1 ? "<$1" : `$${Math.round(value)}`;
const gb = (value: number) => `${value.toLocaleString("en-US")} GB`;
const subStyles =
  "mt-0.5 block text-caption font-normal tracking-normal text-muted normal-case";

function Cell({ value, big }: { value: number; big?: boolean }) {
  return (
    <td className={value === 0 ? "text-muted" : big ? "font-semibold" : ""}>
      {usd(value)}
    </td>
  );
}

export function Cost() {
  const { small, busy } = scenarios;
  return (
    <div className="cols lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <p className="copy">
          Budget {small.budget} a month for the small example. Video and screen
          sharing make the biggest difference.
        </p>
      </div>
      <div>
        <table className="cost">
          <thead>
            <tr>
              <th scope="col">Monthly USD</th>
              <th scope="col">Small instance</th>
              <th scope="col">Busy instance</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Workers paid plan</td>
              <Cell value={small.workers} />
              <Cell value={busy.workers} />
            </tr>
            <tr>
              <td>Durable Objects compute and SQL</td>
              <Cell value={small.durable} />
              <Cell value={busy.durable} />
            </tr>
            <tr>
              <td>D1</td>
              <Cell value={small.d1} />
              <Cell value={busy.d1} />
            </tr>
            <tr>
              <td>R2 attachments</td>
              <Cell value={small.r2} />
              <Cell value={busy.r2} />
            </tr>
            <tr>
              <td>Email</td>
              <Cell value={small.email} />
              <Cell value={busy.email} />
            </tr>
            <tr>
              <td>SFU and TURN egress</td>
              <td className="text-muted">
                {usd(small.sfu)}
                <span className={subStyles}>{gb(small.egressGb)}</span>
              </td>
              <td className="font-semibold">
                {usd(busy.sfu)}
                <span className={subStyles}>{gb(busy.egressGb)}</span>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>Planning budget</td>
              <td>{small.budget}</td>
              <td>{busy.budget}</td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-4 text-caption leading-relaxed text-muted">
          Estimates assume available account allowances. Domains and taxes are
          extra. See the{" "}
          <a href="https://github.com/zllovesuki/vaskel/blob/release/docs/costs.md">
            workloads and assumptions
          </a>
          . Rates checked 23 September 2026.
        </p>
      </div>
    </div>
  );
}
