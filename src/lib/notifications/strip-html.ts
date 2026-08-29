/**
 * Strip HTML tags from notification content, hardened against
 * multi-character bypasses.
 *
 * Every plain-text sender (APNs, Web Push, webhook, ntfy, email) used to
 * carry its own single-pass `replace(/<[^>]*>/g, "")` — the shape CodeQL
 * flags as incomplete multi-character sanitization, because a removal can
 * re-form the very pattern it removed (`<<b>script>` loses `<b>` and the
 * remaining characters close ranks). Whether a given regex happens to be
 * idempotent is an argument about that regex; five copies of the argument
 * across five senders is how the next edit quietly breaks one of them.
 *
 * This helper makes the guarantee structural instead: re-apply the strip
 * until the string stops changing, so a tag re-formed by an earlier
 * removal is removed on the next pass no matter how deep the nesting. The
 * iteration cap bounds CPU on adversarial input; a string still changing
 * at the cap is pathological by construction, and for that remnant the
 * angle brackets themselves are dropped so no `<...>` sequence can ever
 * survive. Plain input without tags returns unchanged, same as the old
 * single pass.
 */

const TAG_RE = /<[^>]*>/g;
const MAX_STRIP_PASSES = 10;

/** Remove HTML tags, re-applying until stable so stripped tags cannot re-form. */
export function stripHtml(text: string): string {
  let out = text;
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const next = out.replace(TAG_RE, "");
    if (next === out) return next;
    out = next;
  }
  // Still changing after the cap — nesting this deep is adversarial.
  // Drop the brackets outright so nothing tag-shaped remains.
  return out.replace(/[<>]/g, "");
}
