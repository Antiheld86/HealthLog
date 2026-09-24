/**
 * One capability for one record, from whichever context is asking.
 *
 * Some readers run both inside an API request and outside one: the dashboard
 * snapshot and the daily digest are read by their routes, by the server
 * components that prefetch them, and by the morning push. Inside a request
 * the route gate answers, and it honours the request's grant (a delegate
 * inside somebody else's record gets that record's masked answer). Outside a
 * request there is no caller to mask for, so the worker path answers with
 * the record's own authority, exactly as a job would.
 *
 * Never throws; an input that cannot be loaded reads `check_failed`.
 */
import { getEvent } from "@/lib/logging/context";

import { aiCapabilityForJob, getAiCapability } from "./gate";
import type { AiCapabilityKey, AiCapabilityState } from "./types";

export function aiCapabilityForRecord(
  recordId: string,
  key: AiCapabilityKey,
): Promise<AiCapabilityState> {
  return getEvent()?.getAuth()?.user_id
    ? getAiCapability(key, { recordId })
    : aiCapabilityForJob(recordId, key);
}
