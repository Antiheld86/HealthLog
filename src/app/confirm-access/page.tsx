import { ConfirmAccessClient } from "./confirm-access-client";
import { confirmReturnTo } from "./return-to";

/**
 * Confirm it is you before connecting an AI assistant.
 *
 * The connection consent (`/api/mcp/oauth/authorize`) is a plain server page
 * with no script, so it cannot run the re-proof dialog itself. When the
 * session has not signed in or re-proved within five minutes it links here;
 * this page runs the same dialog as the rest of the app and then goes back to
 * the consent request it came from.
 */
export default async function ConfirmAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const returnTo = confirmReturnTo(typeof next === "string" ? next : null);
  return <ConfirmAccessClient returnTo={returnTo} />;
}
