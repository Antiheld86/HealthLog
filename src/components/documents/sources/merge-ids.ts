/** Add imported ids to a form's selection, in order, never twice. */
export function mergeIds(selected: string[], added: string[]): string[] {
  const merged = [...selected];
  for (const id of added) if (!merged.includes(id)) merged.push(id);
  return merged;
}
