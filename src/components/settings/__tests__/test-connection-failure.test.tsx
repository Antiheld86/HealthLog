/**
 * The test-connection failure callout (#947).
 *
 * SSR-only, like the rest of the component suite: the callout is hook-free so
 * it renders here without a provider. What is pinned is what a person reads:
 * the translated sentence, the status the other end answered, and the relay's
 * own words as text, never as markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TestConnectionFailure } from "../test-connection-button";

describe("TestConnectionFailure", () => {
  it("shows the sentence with the HTTP status and what the relay said", () => {
    const html = renderToStaticMarkup(
      <TestConnectionFailure
        message="The other end refused the message"
        upstreamStatus={400}
        upstreamBody='{"error":"Bad Request","errorCode":400}'
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("The other end refused the message (HTTP 400)");
    expect(html).toContain(
      "{&quot;error&quot;:&quot;Bad Request&quot;,&quot;errorCode&quot;:400}",
    );
  });

  it("renders a markup-shaped body as characters", () => {
    const html = renderToStaticMarkup(
      <TestConnectionFailure
        message="Upstream returned an error"
        upstreamStatus={502}
        upstreamBody='<img src=x onerror="alert(1)">'
      />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows the SMTP code when there is no HTTP status", () => {
    const html = renderToStaticMarkup(
      <TestConnectionFailure message="Credentials rejected" smtpCode={535} />,
    );

    expect(html).toContain("Credentials rejected (SMTP 535)");
  });

  it("shows the sentence alone when the server sent no detail", () => {
    const html = renderToStaticMarkup(
      <TestConnectionFailure message="Test failed" />,
    );

    expect(html).toContain("Test failed");
    expect(html).not.toContain("HTTP");
    expect(html).not.toContain("test-connection-upstream-body");
  });
});
