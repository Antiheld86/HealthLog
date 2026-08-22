/**
 * A redirect that does not guess the host it is being reached on.
 *
 * `NextResponse.redirect()` demands an absolute URL, and the obvious way to
 * satisfy it is `new URL("/somewhere", req.url)`. Behind a reverse proxy that
 * is wrong, and wrong in the way that is hardest to notice: it works on a
 * developer machine, it works in every test that builds its own request, and
 * it fails only on a deployment where the proxy does not pass `Host` through.
 * There `req.url` is the address the Node process bound to, so the redirect
 * comes back as
 *
 *   location: https://0.0.0.0:3000/auth/login?flow=native
 *
 * which a browser cannot follow and iOS refuses outright ("the restricted
 * network port is not allowed"). It was found on the native sign-in handoff,
 * the primary onboarding path, where the error branches all built a fixed
 * `healthlog://` scheme with no host at all. So the route behaved correctly on
 * every failure and only broke when it was supposed to succeed.
 *
 * A relative `Location` is valid per RFC 7231 section 7.1.2 and is resolved by
 * the client against the URL it actually requested, which is by definition the
 * public one. That needs no configuration, which matters here: the alternative
 * is reading `X-Forwarded-Host`, and every self-hoster would then have one more
 * proxy setting to get right before sign-in works.
 *
 * Use this for any redirect to a path on this same deployment. An absolute URL
 * is still correct when the target is genuinely elsewhere, such as a provider's
 * OAuth authorise endpoint.
 */
import { NextResponse } from "next/server";

/**
 * 307 to a path on this deployment, without naming a host.
 *
 * Returns a `NextResponse`, so callers that need to attach cookies to the
 * redirect keep doing exactly that.
 *
 * 307 rather than 302 preserves the method, matching what
 * `NextResponse.redirect()` sends by default; nothing here should silently turn
 * a POST into a GET.
 */
export function relativeRedirect(path: string): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//")) {
    // A protocol-relative value ("//evil.example") is a host in disguise, and
    // anything not starting with a slash resolves against the current path
    // rather than the root. Both are caller mistakes worth failing loudly.
    throw new Error(
      `relativeRedirect expects a root-relative path, received: ${path}`,
    );
  }
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path },
  });
}
