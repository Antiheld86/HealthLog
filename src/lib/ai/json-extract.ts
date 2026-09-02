/**
 * Isolate the JSON object body of a model reply.
 *
 * Providers without a native JSON mode (Anthropic, the local endpoints)
 * are steered by a prompt instruction alone, and a compliant model still
 * routinely wraps its object in a ```json fence or puts a sentence in
 * front of it. This helper drops a leading/trailing fence and narrows to
 * the outermost `{` ... `}` span so `JSON.parse` sees the object.
 *
 * It is a no-op on already-clean JSON and on fence-free prose with no
 * braces: both return the trimmed input, so a prose fallback downstream
 * still works.
 */
export function extractJsonObject(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) {
    text = fenced[1].trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1);
  }
  return text;
}
