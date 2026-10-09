import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UiLanguage } from "@vaskel/contracts/preferences";
import {
  mentionMarkup,
  mentionTokens,
  parseMessage,
} from "@vaskel/contracts/message-text";
import { BodyView } from "@/client/features/chat/body-view";
import { createI18n } from "@/client/features/i18n/render";
import { I18nProvider } from "@lingui/react";

function markup(
  body: string,
  language: UiLanguage = "en",
  names?: ReadonlyMap<string, string>,
): string {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n: createI18n(language).runtime },
      createElement(BodyView, { body, names }),
    ),
  );
}

describe("shared message Markdown", () => {
  it("renders library-owned nesting, escapes, GFM and chat line breaks", () => {
    const html = markup(
      "重要**警告**です ~~wrong~~\n*yes* and `**literal**`\n\n> quoted\n\n- first\n- second",
    );
    expect(html).toContain(
      "重要<strong>警告</strong>です <del>wrong</del><br/>",
    );
    expect(html).toContain("<em>yes</em>");
    expect(html).toContain("**literal**</code>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<li>second</li>");
    expect(markup("\\*literal\\*")).toContain("*literal*");
  });

  it("uses CommonMark's open fences, long code delimiters and indentation for literal regions", () => {
    const token = mentionMarkup("user-7");
    for (const body of [
      `\`${token}\``,
      `\`\`a \` ${token}\`\``,
      `\`\`\`ts\n${token}`,
      `~~~\n${token}\n~~~`,
      `    ${token}`,
    ]) {
      expect(mentionTokens(body)).toEqual([]);
      expect(markup(body)).not.toContain('class="mention ');
      expect(markup(body)).toContain("/mentions/user-7");
    }
  });

  it("uses the exact same source positions and identities for rendered mentions and owner extraction", () => {
    const token = mentionMarkup("user_7");
    const body = `😀早安 **${token}** ||${mentionMarkup("second")}||`;
    expect(mentionTokens(body)).toEqual([
      {
        userId: "user_7",
        start: body.indexOf(token),
        end: body.indexOf(token) + token.length,
      },
      {
        userId: "second",
        start: body.indexOf("[]", body.indexOf(token) + token.length),
        end: body.length - 2,
      },
    ]);
    const html = markup(
      body,
      "en",
      new Map([["user_7", "Rachel <b>Chen</b>"]]),
    );
    expect(html).toContain("@Rachel &lt;b&gt;Chen&lt;/b&gt;");
    expect(html).not.toContain("user_7");
    expect(html).toContain("@Member");
    expect(markup(token, "ja")).toContain("@メンバー");
    const scriptName = markup(
      token,
      "en",
      new Map([["user_7", "<script>alert('rick roll')</script>"]]),
    );
    expect(scriptName).toContain("&lt;script&gt;");
    expect(scriptName).not.toContain("<script>");
  });

  it("does not grant identity to ordinary links, images, references, HTML or malformed routes", () => {
    const bodies = [
      "[name](/mentions/user-7)",
      "![](/mentions/user-7)",
      "[](/mentions/user-7?x=1)",
      "[](/mentions/)",
      "[](/mentions/%ZZ)",
      `[](/mentions/${"a".repeat(129)})`,
      "[](/other/user-7)",
      "[label][member]\n\n[member]: /mentions/user-7",
      "<div> [](/mentions/user-7) </div>",
      "\\[](/mentions/user-7)",
    ];
    for (const body of bodies) {
      expect(mentionTokens(body), body).toEqual([]);
      expect(markup(body), body).not.toContain('class="mention ');
    }
  });

  it("round-trips encoded opaque identifiers without letting them terminate Markdown destinations", () => {
    for (const id of ["opaque/id", "a)b(c", "a?x#y", "漢字", "a%20b", "a'b!"]) {
      const token = mentionMarkup(id);
      expect(mentionTokens(token)).toEqual([
        { userId: id, start: 0, end: token.length },
      ]);
    }
  });

  it("escapes raw HTML, never loads Markdown images, and allows only web and email navigation", () => {
    const html = markup(
      '<img src="https://tracker.invalid" onerror="bad()">\n\n![alt](https://tracker.invalid/image) [bad](javascript:alert%281%29) [relative](/settings) [safe](https://example.com/a?b=1&c=2) [email](mailto:person@example.com)',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="/settings');
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(html).toContain('href="mailto:person@example.com"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("&lt;img");
  });

  it("keeps concealed spoiler links inert inside the localized reveal control", () => {
    const html = markup("||秘密 [link](https://example.com)||", "ja");
    // The spoiler itself is the control, so a wrapped spoiler stays tappable;
    // the concealed content, links included, is inert and hidden beneath it.
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="隠したテキストを表示"');
    expect(html).toMatch(/inert="" aria-hidden="true"[^>]*>.*<a /su);
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("<button");
    expect(markup("`||literal||`")).not.toContain('role="button"');
    const spoilerLabel = markup("[||secret||](https://example.com)");
    expect(spoilerLabel).toContain('role="button"');
    expect(spoilerLabel).not.toContain("<a ");
  });

  it("processes bounded malformed input without losing parser progress", () => {
    for (const text of [
      "[".repeat(4_000),
      "||*\\`".repeat(800),
      "https://example.com/" + ")".repeat(3_980),
    ]) {
      expect(parseMessage(text).children.length).toBeGreaterThan(0);
    }
  });
});
