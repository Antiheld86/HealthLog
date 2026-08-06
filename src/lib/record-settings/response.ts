/**
 * A request carries its active record through the session cookie, so the
 * client must still reject a response that arrives after a tab switched to a
 * different record. TanStack keys prevent cache aliasing; this closes the
 * in-flight response race before it can populate that key.
 */
export function assertRecordSettingsResponseForRecord(
  response: { recordId: string },
  expectedRecordId: string | null,
): void {
  if (expectedRecordId === null || response.recordId !== expectedRecordId) {
    throw new Error("Managed record settings response did not match its key");
  }
}
