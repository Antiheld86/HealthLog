-- Remove the Health-Score explainer operator switch.
--
-- The toggle gated a caption beside the Health-Score delta line. That
-- caption's component was deleted when the health score was replaced by
-- the reference composite, and the trailing "?" affordance the admin
-- description still named had already been retired a release earlier.
-- The switch has had nothing to switch since; an operator flipping it
-- changed nothing while being told they had.
--
-- Destructive by design: the setting is gone, so its stored value goes
-- with it.
ALTER TABLE "app_settings"
  DROP COLUMN IF EXISTS "assistant_health_score_explainer_enabled";
