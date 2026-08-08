/**
 * How many strips the OVERVIEW teaser paints. It is a glance, not a history;
 * the dedicated `/insights/ecg` page passes no limit and shows every
 * recording.
 *
 * The value lives in its own React- and label-map-free module so the
 * `/insights` overview page can pass it without pulling the ECG label map,
 * its helpers, or the recording component across the dynamic boundary — a
 * bare number is all the eager page imports.
 */
export const ECG_OVERVIEW_LIMIT = 5;
