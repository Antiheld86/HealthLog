-- v1.37 — the five level-A self-state values on a mood entry.
--
-- A mood entry has carried one 1-5 value since the first release. That value
-- keeps its scale and its meaning; these five ride beside it, each 0-10 with
-- its own anchors: pleasantness, stress, energy, connectedness and stability.
--
-- All five are nullable, which is what makes this an additive change rather
-- than a table rewrite, and nullable is also the honest shape: only the first
-- one can be derived from what a row already carries, and the other four stay
-- empty until somebody answers them. A default would fill a hundred thousand
-- historical rows with a number nobody chose.
--
-- No CHECK constraint on the range. Bounds are enforced server-side, the same
-- way `mood_entry_tag_links.rating` documents: a future change to the scale
-- must not strand rows written under the old one.
ALTER TABLE "mood_entries"
  ADD COLUMN "mood_a1" INTEGER,
  ADD COLUMN "stress_a2" INTEGER,
  ADD COLUMN "energy_a3" INTEGER,
  ADD COLUMN "connection_a4" INTEGER,
  ADD COLUMN "stability_a5" INTEGER;
