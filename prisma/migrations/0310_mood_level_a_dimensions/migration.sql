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

-- Map every entry written before these columns existed onto the pleasantness
-- scale. The five-point label is the only thing a historical row can answer
-- from, so it is the only column filled: stress, energy, connectedness and
-- stability stay NULL, because there is nothing to derive them from and an
-- invented number would be indistinguishable from one somebody gave.
--
-- The anchors are 1/3/5/7/9, matching `MOOD_A1_MAP` in
-- `src/lib/validations/mood.ts` — the runtime map and these arms are compared
-- to each other by a test, so the two cannot drift apart. Not 0 and 10 at the
-- ends: the five-point endpoints mean as bad or as good as that instrument
-- can express, not as bad or as good as a person can feel, and pinning them
-- to the extremes would make every mapped row read as more extreme than every
-- hand-set one.
--
-- `WHERE mood_a1 IS NULL` makes a re-run a no-op instead of an overwrite. A
-- migration re-applied against a database that has since taken real answers
-- must not replace them with the mapped value.
UPDATE mood_entries
   SET mood_a1 = CASE mood
     WHEN 'LAUSIG' THEN 1
     WHEN 'SCHLECHT' THEN 3
     WHEN 'OKAY' THEN 5
     WHEN 'GUT' THEN 7
     WHEN 'SUPER_GUT' THEN 9
   END
 WHERE mood_a1 IS NULL
   AND mood IN ('LAUSIG', 'SCHLECHT', 'OKAY', 'GUT', 'SUPER_GUT');
