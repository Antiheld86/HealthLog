/**
 * One service for every link between two of an account's own records.
 *
 * Two families live behind it today: a visit's links to the documents, lab
 * results and conditions it produced, and a document's links to the conditions
 * it is filed against. They are separate tables and one call signature.
 *
 * The reason for the shape rather than four more call sites: the standing
 * lesson from the polymorphic-linking work is "one shared service", and this
 * release adds three narrow link tables, which is a bounded step the other way.
 * Bounded by this module. Every caller speaks one vocabulary — a source, a
 * target kind and a list of target ids — so replacing the storage underneath
 * later is a change here and not a sweep across every route that files
 * something.
 *
 * Rules the module owns, so no call site re-implements them:
 *
 *   - **Ownership is verified here.** Both ends are re-read scoped by `userId`
 *     before a row is written. Passing another account's document id links
 *     nothing; the id comes back in `unknownTargetIds` and the caller decides
 *     whether that is a refusal or a silent no-op.
 *   - **Idempotent.** Linking a pair that already exists succeeds and changes
 *     nothing, matching the document bulk route's behaviour today.
 *   - **Bounded.** At most {@link MAX_TARGETS_PER_CALL} ids per call.
 *   - **Soft-deleted rows are not linkable**, on either end. A tombstoned
 *     document cannot be filed against a visit, and a deleted visit cannot
 *     collect new links.
 *
 * One documented exemption: `src/lib/export/visits-backup.ts` writes the link
 * tables directly. A restore is rebuilding an account rather than filing
 * something in one — it preserves ids and creation instants, and it must not
 * re-run an ownership narrowing against rows it is in the middle of creating.
 * It is the same exemption the wipe plan and the key rotation hold, for the
 * same reason, and it is the only one.
 */
export {
  MAX_TARGETS_PER_CALL,
  linkTargets,
  unlinkTargets,
  replaceTargets,
  listTargets,
  listTargetsBySource,
  listDistinctTargets,
  type LinkTargetKind,
} from "@/lib/links/link-service";
