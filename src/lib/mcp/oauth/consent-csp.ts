/**
 * Content-Security-Policy for the MCP OAuth authorization endpoint.
 *
 * The consent screen is a plain HTML form that posts to its own origin; on
 * "Allow" or "Deny" the server answers with a redirect to the client's
 * `redirect_uri`. Chromium applies the document's `form-action` to every hop of
 * that navigation, redirects included, so the app-wide `form-action 'self'`
 * strands the user on the consent screen after the grant was already issued.
 *
 * The route therefore owns the CSP of its own responses (the proxy leaves this
 * exact path alone). The consent page allows `form-action` for `'self'` plus
 * the ORIGIN of the one redirect URI the route has just validated against the
 * resolved client for this request, never a client-supplied value that has not
 * passed that check. Every other response from the route gets the strict
 * policy with `form-action 'self'`. The pages carry no script, style or
 * subresource, so everything else is `'none'`.
 */

const CSP_REPORT_ENDPOINT = "/api/monitoring/csp-report";

/**
 * The origin a validated redirect URI may add to `form-action`, or null.
 * Registration only admits `https:` and `http:` loopback URIs; anything else
 * (or anything unparsable) adds nothing, so a later relaxation of the
 * registration rules cannot silently widen this policy.
 */
export function formActionOrigin(redirectUri: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/** The policy string. Pass the validated redirect URI only on the consent page. */
export function authorizeCsp(validatedRedirectUri?: string): string {
  const extra = validatedRedirectUri
    ? formActionOrigin(validatedRedirectUri)
    : null;
  const formAction = extra ? `'self' ${extra}` : "'self'";
  return [
    "default-src 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    `report-uri ${CSP_REPORT_ENDPOINT}`,
  ].join("; ");
}

/**
 * Return `response` with the authorize CSP set. A fresh `Response` is built
 * because `Response.redirect()` and `Response.json()` can carry immutable
 * headers.
 */
export function withAuthorizeCsp(
  response: Response,
  validatedRedirectUri?: string,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", authorizeCsp(validatedRedirectUri));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
