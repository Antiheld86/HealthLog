-- The OpenAI-compatible gateway provider (#470): a user-configured endpoint
-- that speaks `/v1/chat/completions` — LiteLLM, OpenRouter, vLLM, or anything
-- else on that wire — with its own base URL, its own optional bearer, and its
-- own model.
--
-- Three dedicated columns instead of reusing `ai_base_url` / the OpenAI key.
-- The OpenAI arm pins `api.openai.com` on purpose, so it must have no column
-- in common with a provider whose host the user chooses; and the gateway must
-- never receive the key the user issued for OpenAI. Separating the storage
-- makes both properties structural rather than a comment someone can delete.
--
-- All three are nullable and additive: an install that never configures the
-- provider carries three NULLs and resolves exactly as before.

ALTER TABLE "users" ADD COLUMN "ai_compat_base_url" TEXT;
ALTER TABLE "users" ADD COLUMN "ai_compat_key_encrypted" TEXT;
ALTER TABLE "users" ADD COLUMN "ai_compat_model" TEXT;
