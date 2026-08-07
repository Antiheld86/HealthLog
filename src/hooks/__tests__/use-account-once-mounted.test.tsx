import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { useAccountOnceMounted, useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";

/**
 * `useAccountOnceMounted()` withholds the account payload from the server
 * render, and by the same mechanism from the hydration render.
 *
 * ## What broke
 *
 * The app shell hydrates from the streamed HTML shell and its mount fires
 * `/api/auth/me`. A page below a `loading.tsx` is a streamed Suspense boundary
 * that hydrates LATER — routinely after that response has landed. Its first
 * CLIENT render then reads an account payload the server never had (an RSC
 * renders with no query cache), so every account-derived branch renders
 * something else, React reports #418 and discards the whole streamed tree. On
 * `/` that was the dashboard's entire SSR prefetch, thrown away on every cold
 * load.
 *
 * ## What this pins, and what it cannot
 *
 * `useMounted()` answers with its SERVER snapshot during SSR *and* during
 * hydration, so one gate covers both. The unit suite has no DOM, so it cannot
 * run a hydration pass — but it can assert the half that is observable here,
 * and the half that says a server render may not consult the cache: given a
 * client whose `authMe` cell is ALREADY populated, the hook still has to answer
 * null. Drop the mount gate and this goes red, because `query.data` is right
 * there to be read. The contrast case pins that plain `useAuth()` does read it,
 * which is what the redirect gates depend on.
 *
 * That the hydration render then agrees with the server is covered end to end
 * by `e2e/dashboard-ssr-prefetch-hydration.spec.ts`, which runs against a
 * server with the prefetch flag in its shipped state.
 */
function PinnedProbe() {
  const user = useAccountOnceMounted();
  return <span>{user ? user.username : "no-account"}</span>;
}

function LiveProbe() {
  const { user } = useAuth();
  return <span>{user ? user.username : "no-account"}</span>;
}

function clientWithAccount(): QueryClient {
  const client = new QueryClient();
  // Exactly the state the browser is in when a streamed page boundary
  // hydrates: the shell already asked, and the answer is in the cache.
  client.setQueryData(queryKeys.authMe(), {
    id: "account-1",
    username: "someone",
    role: "USER",
    timezone: "Europe/Berlin",
  });
  return client;
}

function render(client: QueryClient, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

describe("useAccountOnceMounted", () => {
  it("answers null even when the authMe cell already carries a payload", () => {
    const html = render(clientWithAccount(), <PinnedProbe />);
    expect(html).toContain("no-account");
    expect(html).not.toContain("someone");
  });

  it("answers null with an empty cache too", () => {
    expect(render(new QueryClient(), <PinnedProbe />)).toContain("no-account");
  });

  it("leaves plain useAuth reading the cache, which the redirect gates need", () => {
    expect(render(clientWithAccount(), <LiveProbe />)).toContain("someone");
  });
});
