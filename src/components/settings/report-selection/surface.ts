/**
 * Which surface a scope picker is mounted on.
 *
 * Settings → Gesundheitsakte carries BOTH mounts on one page: the export panel
 * at the top and the share-link create form under `#sharing`. They are the same
 * component by design — two selection UIs must not drift apart — but that made
 * every test id inside the picker resolve twice on that page, so nothing in it
 * was addressable.
 *
 * The surface is therefore required, not optional, and every test id under the
 * picker ends with it: `report-group-row-vitals-export` and
 * `report-group-row-vitals-share` are two different controls and read as two
 * different controls. A third mount adds a value here and stays addressable by
 * construction.
 */
export type ReportScopeSurface = "export" | "share";
