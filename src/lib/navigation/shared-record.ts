import {
  ENTIRE_RECORD,
  SHARE_DOMAINS,
  type ShareDomain,
  type ShareScope,
} from "@/lib/sharing/scope";

/**
 * The browser route families a scoped grant can present.
 *
 * This is deliberately a presentation inventory, not an authorization table.
 * `sections` arrives here as the server-resolved value from `accountAccess`;
 * the request handler still evaluates the active grant for every read and
 * mutation. Keeping the browser's route families closed lets a new domain
 * fail closed in chrome until it has been intentionally classified.
 */
export const SHARED_RECORD_DOMAIN_ROUTE_FAMILIES = {
  measurements: ["/measurements"],
  medications: ["/medications"],
  labs: ["/labs"],
  profile: ["/profile"],
  illness: ["/illness"],
  mind: ["/mood", "/mental-wellbeing"],
  cycle: ["/cycle"],
  documents: ["/documents"],
} as const satisfies Record<ShareDomain, readonly `/${string}`[]>;

/**
 * Routes whose reads span multiple domains. A selected-domain grant never
 * opens these, even when it happens to name every currently known domain.
 */
const WHOLE_RECORD_ROUTE_FAMILIES = ["/", "/achievements"] as const;

interface RouteFamily {
  href: string;
  scope: ShareScope;
}

const SHARED_RECORD_ROUTE_FAMILIES: readonly RouteFamily[] = [
  ...WHOLE_RECORD_ROUTE_FAMILIES.map((href): RouteFamily => ({
    href,
    scope: ENTIRE_RECORD,
  })),
  ...SHARE_DOMAINS.flatMap((domain): RouteFamily[] =>
    SHARED_RECORD_DOMAIN_ROUTE_FAMILIES[domain].map((href): RouteFamily => ({
      href,
      scope: domain,
    })),
  ),
];

function matchesRouteFamily(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function includesScope(
  sections: readonly ShareDomain[] | null,
  scope: ShareScope,
): boolean {
  if (sections === null) return true;
  return scope !== ENTIRE_RECORD && sections.includes(scope);
}

/**
 * Server-resolved navigation paint for the active shared record.
 *
 * The return value never makes an authorization decision. It only prevents a
 * known-unavailable page from mounting its reads after the server has already
 * said which record sections the browser is inside.
 */
export function resolveSharedRecordNavigation(
  sections: readonly ShareDomain[] | null,
) {
  const routeFamilies = SHARED_RECORD_ROUTE_FAMILIES.filter((family) =>
    includesScope(sections, family.scope),
  );

  return {
    destinationHrefs: routeFamilies.map((family) => family.href),
    allowsPath(pathname: string): boolean {
      return routeFamilies.some((family) =>
        matchesRouteFamily(pathname, family.href),
      );
    },
  };
}

/** The first scope-presentable location to load after a record switch. */
export function sharedRecordLandingHref(
  sections: readonly ShareDomain[] | null,
): string {
  return resolveSharedRecordNavigation(sections).destinationHrefs[0] ?? "/";
}

/**
 * Does the server-resolved scope make this browser route presentable?
 *
 * This helper is intentionally named for presentation. It must never be used
 * by a route handler or to choose an API request's target record.
 */
export function isSharedRecordPathPresentable(
  pathname: string,
  sections: readonly ShareDomain[] | null,
): boolean {
  return resolveSharedRecordNavigation(sections).allowsPath(pathname);
}
