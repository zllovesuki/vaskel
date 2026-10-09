import { LucideProvider } from "lucide-react";
import { iconDefaults } from "@vaskel/ui/components/control-styles";
import { Band } from "@/site/page/band";
import { Cost } from "@/site/page/cost";
import { InstallPrompt } from "@/site/page/install-prompt";
import { Deploy } from "@/site/page/deploy";
import { Footer } from "@/site/page/footer";
import { Host, Invite } from "@/site/page/host";
import { Needs } from "@/site/page/needs";
import { Step } from "@/site/page/step";
import { Preview } from "@/site/preview/preview";

/** The page is the install file: step 0 is the product, steps 1–5 are how you get it. */
export function App() {
  return (
    <LucideProvider {...iconDefaults}>
      <span id="top" />
      <Band />
      <main>
        <Step
          id="what"
          number={0}
          title="What you get"
          aside={<InstallPrompt />}
          hero
        >
          <Preview />
        </Step>
        <Step
          id="need"
          number={1}
          title="What you need"
          lede="Your account, your domain. Your agent helps with the rest."
        >
          <Needs />
        </Step>
        <Step id="deploy" number={2} title="Deploy, with your agent">
          <Deploy />
        </Step>
        <Step id="host" number={3} title="Become the host">
          <Host />
        </Step>
        <Step id="invite" number={4} title="Invite your people">
          <Invite />
        </Step>
        <Step id="cost" number={5} title="What it costs">
          <Cost />
        </Step>
      </main>
      <Footer />
    </LucideProvider>
  );
}
