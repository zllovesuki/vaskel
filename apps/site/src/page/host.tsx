import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import {
  buttonStyles,
  fieldStyles,
  labelStyles,
} from "@vaskel/ui/components/control-styles";

const entryStyles = "rounded-[12px] border border-line bg-surface p-6";
const headingStyles = "mb-1 text-[1.1rem] font-[650] tracking-[-0.02em]";
const descriptionStyles = "mb-4 text-caption leading-normal text-muted";

function ExampleField({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${labelStyles} mb-3.5`}>
      {label}
      <span className={`${fieldStyles} block font-normal ${className}`}>
        {children}
      </span>
    </div>
  );
}

export function Host() {
  return (
    <div className="cols">
      <div className="flex flex-col gap-3">
        <p className="copy">
          Use the setup key to create your host account. Verify your email and
          sign in.
        </p>
        <p className="copy">
          As host, you choose the name and who can invite people.
        </p>
      </div>
      <div
        className={`${entryStyles} max-w-[420px]`}
        role="img"
        aria-label="The bootstrap screen: setup key, host email, display name, password, and a Create host account button."
      >
        <div aria-hidden="true">
          <h3 className={headingStyles}>Set up this vaskel.</h3>
          <p className={descriptionStyles}>
            The setup key was given to you separately from this link. It works
            once.
          </p>
          <ExampleField label="Setup key">
            <span className="text-muted opacity-90">Paste the setup key</span>
          </ExampleField>
          <ExampleField label="Host email">wren@example.org</ExampleField>
          <ExampleField label="Display name">wren</ExampleField>
          <ExampleField label="Password">••••••••••••••••</ExampleField>
          <span className={buttonStyles({ variant: "primary" })}>
            Create host account
          </span>
        </div>
      </div>
    </div>
  );
}

export function Invite() {
  return (
    <div className="cols">
      <div className="flex flex-col gap-3">
        <p className="copy">
          Create a circle and a few rooms, then send an invitation. Once your
          friends join, start a conversation or hop into a call.
        </p>
        <p className="copy">People see only the circles they belong to.</p>
      </div>
      <div
        className={entryStyles}
        role="img"
        aria-label="The invitations section in circle settings: a number-of-people field, one invitation link shown once with Copy invite link, and Create another invitation."
      >
        <div aria-hidden="true">
          <h3 className={headingStyles}>Invitations</h3>
          <p className={descriptionStyles}>Loft · members may invite</p>
          <ExampleField label="Number of people" className="max-w-[120px]">
            4
          </ExampleField>
          <div className="rows">
            <div className="row">
              <span className="lines">
                Invitation link
                <span className="s">
                  <code>chat.example.org/join?invite=6f1c…c9e2</code> · shown
                  only now
                </span>
              </span>
              <span className={buttonStyles({ size: "small" })}>
                <Copy className="size-4" />
                Copy invite link
              </span>
            </div>
            <div className="row">
              <span className="lines">
                Created 2 minutes ago · 4 people
                <span className="s">Unused</span>
              </span>
            </div>
          </div>
          <div className="mt-3.5">
            <span className={buttonStyles()}>Create another invitation</span>
          </div>
        </div>
      </div>
    </div>
  );
}
