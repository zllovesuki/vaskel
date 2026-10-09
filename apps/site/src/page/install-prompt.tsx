import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";

export const INSTALL_URL = "https://vaskel.com/INSTALL.md";
export const INSTALL_PROMPT = `Set up vaskel. using ${INSTALL_URL}. Guide me through any prerequisites.`;

/** The one line a host copies; the page's spine. */
export function InstallPrompt() {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const fallback = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (status === "failed") {
      fallback.current?.focus();
      fallback.current?.select();
    }
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [status]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_PROMPT);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <div className="flex min-w-0 max-w-[440px] flex-col items-end gap-2 max-lg:items-start">
      <div className="flex min-h-control-tall max-w-full self-stretch overflow-hidden rounded-lg border border-line bg-surface shadow-row pointer-coarse:min-h-control-touch">
        {status === "failed" ? (
          <input
            ref={fallback}
            className="min-w-0 flex-1 bg-transparent px-3.5 font-mono text-ui"
            aria-label="Setup prompt"
            readOnly
            value={INSTALL_PROMPT}
            onFocus={(event) => event.currentTarget.select()}
          />
        ) : (
          <a
            href={INSTALL_URL}
            className="flex min-w-0 flex-1 items-center px-3.5 font-mono text-ui font-semibold text-ink no-underline hover:underline"
          >
            <span className="truncate">vaskel.com/INSTALL.md</span>
          </a>
        )}
        <button
          type="button"
          onClick={copy}
          className="flex min-w-[112px] shrink-0 items-center justify-center gap-1.5 border-l border-line bg-subtle px-3 text-caption font-semibold text-ink hover:bg-sidebar-hover"
          aria-label="Copy setup prompt"
        >
          <Copy className="size-4" aria-hidden="true" />
          <span>{status === "copied" ? "Copied" : "Copy prompt"}</span>
        </button>
      </div>
      <p
        role="status"
        className="text-right text-caption text-muted max-lg:text-left"
      >
        {status === "failed"
          ? "Clipboard unavailable. Copy the selected prompt manually."
          : status === "copied"
            ? "Setup prompt copied. Paste it into your coding agent."
            : "Copy the prompt for your agent, or read the file."}
      </p>
    </div>
  );
}
