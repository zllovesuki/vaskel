import { Session } from "./session";

export function Deploy() {
  return (
    <div className="cols">
      <div className="flex flex-col gap-3">
        <p className="copy">
          Give INSTALL.md to your agent. Choose your app's address and email
          sender; it takes care of the setup.
        </p>
        <p className="copy">When it's ready, you get a link and setup key.</p>
      </div>
      <Session />
    </div>
  );
}
