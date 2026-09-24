/**
 * Leave the client router and load `path` as a new document.
 *
 * For destinations the client router cannot serve: an API route that answers
 * with a redirect (an OAuth connect, a sign-in hand-off), or a page that has
 * to start from a fresh document because the client state of the old one no
 * longer belongs to anybody (after the account was deleted).
 *
 * In-app page changes use `useRouter().push()` instead.
 */
export function loadDocument(path: string): void {
  window.location.assign(path);
}
