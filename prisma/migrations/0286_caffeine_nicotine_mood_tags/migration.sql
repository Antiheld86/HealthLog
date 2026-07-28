-- Data-only, idempotent extension of the built-in binary mood-tag catalogue.
-- Mirrors migration 0101's deterministic-id and key-conflict taxonomy pattern.
INSERT INTO "mood_tags" (
  "id", "category_id", "key", "label_key", "icon", "sort_order",
  "is_active", "kind", "scale_min", "scale_max", "inverse", "user_id",
  "label_encrypted"
)
VALUES (
  'mt_caffeine', 'mtc_health', 'caffeine', 'mood.tag.caffeine', 'Coffee', 5,
  true, 'BINARY', 1, 5, false, NULL, NULL
)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id",
  "label_key" = EXCLUDED."label_key",
  "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order",
  "kind" = EXCLUDED."kind",
  "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max",
  "inverse" = EXCLUDED."inverse";

INSERT INTO "mood_tags" (
  "id", "category_id", "key", "label_key", "icon", "sort_order",
  "is_active", "kind", "scale_min", "scale_max", "inverse", "user_id",
  "label_encrypted"
)
VALUES (
  'mt_nicotine', 'mtc_health', 'nicotine', 'mood.tag.nicotine', 'Cigarette', 6,
  true, 'BINARY', 1, 5, false, NULL, NULL
)
ON CONFLICT ("key") DO UPDATE SET
  "category_id" = EXCLUDED."category_id",
  "label_key" = EXCLUDED."label_key",
  "icon" = EXCLUDED."icon",
  "sort_order" = EXCLUDED."sort_order",
  "kind" = EXCLUDED."kind",
  "scale_min" = EXCLUDED."scale_min",
  "scale_max" = EXCLUDED."scale_max",
  "inverse" = EXCLUDED."inverse";
