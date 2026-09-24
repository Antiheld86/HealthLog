/**
 * v1.12.1 — server-side consent gate before external-LLM PHI egress.
 *
 * The `ConsentReceipt` infrastructure (`latestActiveReceipt`,
 * `ai_full | ai_insights_only | ai_coach`, append-only audit trail) was built
 * but never enforced as a precondition: a direct API caller with a valid
 * bearer/cookie could trigger external-LLM processing of their own health
 * snapshot with no receipt on file. Consent was enforced client-side only.
 *
 * This guard closes that gap. Before the first external-provider call on a
 * SERVER-MANAGED path — i.e. the operator's global OpenAI key resolved via
 * `resolveAdminProvider` and tagged `admin-openai` in the chain — an active,
 * non-revoked receipt is required for the calling user.
 *
 * Scope, deliberately narrow (per the audit's fix sketch + the launch task):
 *   - GATED:   `admin-openai` — the operator's global key forwards the user's
 *              metrics to a third-party processor the user did not contract
 *              with directly. This is the egress consent law cares about.
 *   - UNGATED: a user's own BYOK key (`openai` / `anthropic`), their own
 *              ChatGPT OAuth account (`codex`), and the self-hosted `local`
 *              provider. These are the user's own egress to a processor they
 *              chose; the existing settings flow is the consent act there.
 *
 * The check fails CLOSED: a chain that COULD egress via the server-managed
 * key requires a receipt even when a BYOK provider sits ahead of it in the
 * chain, because the runner may cascade to the admin key on a primary
 * failure and we must not race that decision. A receipt of the surface's
 * mapped kind OR the superset `ai_full` grant satisfies the gate.
 */
import {
  AI_EXTRACTION_CONSENT_KIND,
  latestActiveReceipt,
} from "@/lib/consent/receipts";
import type { ConsentKind } from "@/lib/validations/consent";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

/**
 * The consent groups that gate PHI egress. Each maps to the consent kind
 * collected for it; `ai_full` (the master grant) satisfies every one.
 *
 *   - `coach`: the Coach (`ai_coach`).
 *   - `insights`: model-written analysis over the person's own readings
 *     (`ai_insights_only`).
 *   - `extraction`: reading a document, a lab report scan or typed medication
 *     text (`ai_extraction`, the narrower grant the document auto-read toggle
 *     mints). It no longer satisfies the Coach or the analysis, and neither of
 *     those satisfies it.
 */
export type ConsentSurface = "coach" | "insights" | "extraction";

/**
 * Provider tags that egress via an operator-managed credential the user did not
 * personally contract: the operator's global OpenAI key (`admin-openai`) and the
 * operator's shared central Codex / ChatGPT-subscription account (`admin-codex`).
 * Both require an active consent receipt before any PHI leaves for them.
 */
const SERVER_MANAGED_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "admin-openai",
  "admin-codex",
]);

/**
 * Error thrown when an external-LLM egress on a server-managed key is
 * attempted without an active consent receipt. Mirrors `AssistantDisabledError`
 * so the api-handler renders the same 403 envelope shape the iOS client
 * already branches on:
 *
 *   { data: null, error: "...", meta: { errorCode: "consent.ai.required" } }
 */
export class ConsentRequiredError extends Error {
  readonly errorCode = "consent.ai.required" as const;
  readonly surface: ConsentSurface;

  constructor(surface: ConsentSurface) {
    super(
      `Active AI consent is required before processing health data on the server-managed provider (surface: ${surface})`,
    );
    this.name = "ConsentRequiredError";
    this.surface = surface;
  }
}

/**
 * True when the resolved provider chain contains at least one entry that
 * would egress via the operator's server-managed/global key. BYOK + local +
 * the user's own ChatGPT OAuth never trip this.
 */
export function chainRequiresServerManagedConsent(
  chain: ReadonlyArray<ProviderChainResolved>,
): boolean {
  return chain.some((entry) =>
    SERVER_MANAGED_PROVIDER_TYPES.has(entry.providerType),
  );
}

/** The consent kinds that satisfy a given surface (the specific + the master). */
function acceptableKinds(surface: ConsentSurface): ConsentKind[] {
  switch (surface) {
    case "coach":
      return ["ai_coach", "ai_full"];
    case "insights":
      return ["ai_insights_only", "ai_full"];
    case "extraction":
      return [AI_EXTRACTION_CONSENT_KIND, "ai_full"];
  }
}

/**
 * Return whether the user has an active receipt that satisfies `surface`.
 * Reads the specific kind first, then the master `ai_full` grant — at most
 * two indexed point-reads, short-circuiting on the first hit.
 */
export async function hasActiveConsentForSurface(
  userId: string,
  surface: ConsentSurface,
): Promise<boolean> {
  for (const kind of acceptableKinds(surface)) {
    if (await latestActiveReceipt(userId, kind)) return true;
  }
  return false;
}

/**
 * Enforce the consent precondition for a resolved provider chain.
 *
 * No-op when the chain has no server-managed entry (pure BYOK / local / codex
 * egress is the user's own act and stays ungated). When the chain COULD egress
 * via the operator's key, throw `ConsentRequiredError` unless an active
 * receipt of the surface's mapped kind (or `ai_full`) is on file.
 *
 * Call this AFTER the chain is resolved and BEFORE the first
 * `runRawCompletionWithFallback` / `runWithFallback` call.
 */
export async function assertConsentForChain(args: {
  userId: string;
  chain: ReadonlyArray<ProviderChainResolved>;
  surface: ConsentSurface;
}): Promise<void> {
  if (!chainRequiresServerManagedConsent(args.chain)) return;
  if (await hasActiveConsentForSurface(args.userId, args.surface)) return;
  throw new ConsentRequiredError(args.surface);
}

/**
 * The DOCUMENT-class consent gate (governance fix, oauth-investigation
 * SYNTHESIS §2).
 *
 * The self-snapshot gate above leaves BYOK / codex / local UNGATED on the
 * theory that "configuring the provider was the consent act." That theory holds
 * for a metrics snapshot the account owner sends about themselves. It is too
 * thin for an uploaded medical DOCUMENT: sending a scanned discharge letter to
 * ANY third-party AI is the egress data-protection law cares about, and the
 * codex (ChatGPT-subscription) backend trains on consumer content by default.
 *
 * So for the document surfaces the gate is stricter and PICK-based: the vault
 * AI routes call the single resolved provider directly (no runner cascade), so
 * the exact egress is the picked provider. A `local` pick never leaves the
 * machine and stays ungated; EVERY external pick (codex, BYOK openai/anthropic,
 * the operator's admin key) requires an active document-class consent receipt.
 */
const LOCAL_ONLY_PROVIDER_TYPES: ReadonlySet<string> = new Set(["local"]);

/**
 * True when reading a document through this provider egresses it OFF the machine
 * to a third-party AI service. Only the self-hosted `local` provider keeps the
 * document on the operator's own infrastructure.
 */
export function isExternalDocumentEgress(providerType: string): boolean {
  return !LOCAL_ONLY_PROVIDER_TYPES.has(providerType);
}

/**
 * Enforce the document-class consent precondition for the provider that will
 * actually receive the document. No-op for a `local` pick (nothing leaves the
 * machine); for any external pick, throw `ConsentRequiredError` unless an
 * active extraction receipt (`ai_extraction`, or the master `ai_full`) is on
 * file.
 *
 * The document auto-read toggle is NOT a shortcut here any more. Switching it
 * on mints an `ai_extraction` receipt, and that receipt is what this reads, so
 * a receipt the person later revokes wins over a toggle still left on: the
 * withdrawal is honoured at the next egress, not at the next toggle flip.
 *
 * Call this AFTER the document provider is picked and BEFORE the first
 * `generateCompletion` on it.
 */
export async function assertDocumentEgressConsent(args: {
  userId: string;
  providerType: string;
}): Promise<void> {
  if (!isExternalDocumentEgress(args.providerType)) return;
  if (await hasActiveConsentForSurface(args.userId, "extraction")) return;
  throw new ConsentRequiredError("extraction");
}

/**
 * The document rule for a provider CHAIN (lab report scans, which cascade
 * across the chain rather than calling one picked provider). A lab report is a
 * document, so any entry that would send it off the machine needs an active
 * extraction receipt, whoever holds the credential; a chain of local entries
 * only is ungated. Fails closed like `assertConsentForChain`: an external
 * entry anywhere in the chain requires the receipt, because the runner may
 * cascade to it.
 */
export async function assertExtractionConsentForChain(args: {
  userId: string;
  chain: ReadonlyArray<ProviderChainResolved>;
}): Promise<void> {
  if (
    !args.chain.some((entry) => isExternalDocumentEgress(entry.providerType))
  ) {
    return;
  }
  if (await hasActiveConsentForSurface(args.userId, "extraction")) return;
  throw new ConsentRequiredError("extraction");
}
