import type {
  IntegrationKey,
  IntegrationState,
} from "@/lib/integrations/status";

/**
 * A status-ledger row alone cannot prove a connection: integrations without a
 * row synthesize a healthy ledger state for the owner Settings dashboard. The
 * managed projection must instead report those as disconnected until its
 * record carries a real credential or connection row.
 */
export function resolveManagedIntegrationState(
  state: IntegrationState,
  connected: Record<IntegrationKey, boolean>,
  integration: IntegrationKey,
): IntegrationState {
  return connected[integration] ? state : "disconnected";
}
