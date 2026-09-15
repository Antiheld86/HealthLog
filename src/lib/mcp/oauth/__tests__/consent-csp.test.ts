import { describe, expect, it } from "vitest";

import {
  authorizeCsp,
  formActionOrigin,
  withAuthorizeCsp,
} from "../consent-csp";

describe("authorize CSP", () => {
  it("allows only 'self' in form-action without a validated redirect", () => {
    const csp = authorizeCsp();
    expect(csp).toContain("form-action 'self';");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/script-src|style-src|unsafe/);
  });

  it("adds the origin of the validated redirect URI, not its path or query", () => {
    const csp = authorizeCsp(
      "https://claude.ai/api/mcp/auth_callback?x=1#frag",
    );
    expect(csp).toContain("form-action 'self' https://claude.ai;");
  });

  it("keeps the port of a loopback redirect", () => {
    expect(authorizeCsp("http://127.0.0.1:53682/callback")).toContain(
      "form-action 'self' http://127.0.0.1:53682;",
    );
  });

  it("adds nothing for a scheme registration never admits", () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "myapp://callback",
      "not a url",
      "",
    ]) {
      expect(formActionOrigin(uri), uri).toBeNull();
      expect(authorizeCsp(uri), uri).toContain("form-action 'self';");
    }
  });

  it("sets the header on responses whose headers are immutable", async () => {
    const redirect = Response.redirect("https://claude.ai/cb", 302);
    const res = withAuthorizeCsp(redirect);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://claude.ai/cb");
    expect(res.headers.get("content-security-policy")).toContain(
      "form-action 'self';",
    );

    const json = withAuthorizeCsp(Response.json({ ok: true }, { status: 400 }));
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ ok: true });
  });
});
