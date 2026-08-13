/**
 * Page size of the mood management list — shared by the client list query
 * (`components/mood/mood-list.tsx`) and the `/mood` RSC prefetch wrapper, so
 * the server-seeded first page carries exactly the slice the client's
 * first-mount `queryFn` would fetch. Deliberately dependency-free: the client
 * bundle must be able to import it, so it cannot live in the (server-only)
 * list read next to the query it parameterises.
 */
export const MOOD_LIST_PAGE_SIZE = 25;
