/**
 * The one declaration of what a backup contains, and what it deliberately does
 * not.
 *
 * The wipe plan next door ({@link ../data-wipe/wipe-plan}) answers the mirror
 * question and got the same treatment for the same reason: a list that was
 * right the day it was written, then quietly stopped being right every time a
 * model was added. On the delete side that meant data survived a wipe. On this
 * side it means data does not survive a restore, which is worse, because a
 * wipe at least tells you it happened.
 *
 * ── Why this list is longer than the wipe list ──────────────────────────────
 *
 * The wipe may lean on the database: deleting a `Medication` cascades to its
 * schedules, dose changes and inventory events, so the wipe plan never has to
 * name them. **A restore has no cascade.** Every child has to be carried
 * explicitly and re-inserted explicitly, so sixteen models the wipe plan never
 * needed to mention are decisions here.
 *
 * ── The three verdicts ──────────────────────────────────────────────────────
 *
 * `BACKED_UP`   — the account would lose something real if this were missing.
 *
 *                 **Read this as "must be", not "is".** Today the guard beside
 *                 this file checks only that every model HAS a verdict. The
 *                 two-ended check — that each `BACKED_UP` model has both a
 *                 payload reader and a restore branch — does not exist yet,
 *                 and roughly 31 of the models listed here have neither end.
 *                 Three were closed in v1.33.1 (custom cycle symptoms,
 *                 nutrient day totals, custom mood tags); the rest are named
 *                 here so the gap is written down instead of invisible, which
 *                 is the only honest thing this list can do before the guard
 *                 exists.
 *
 *                 An earlier draft of this comment claimed the two-ended guard
 *                 in the present tense. It did not exist then either. That is
 *                 the same defect this file was written to prevent, so it is
 *                 recorded rather than quietly corrected.
 * `DERIVED`     — recomputable from `BACKED_UP` rows. Leaving it out keeps the
 *                 file smaller and cannot lose anything; the reason names what
 *                 recomputes it.
 * `NOT_IN_BACKUP` — deliberately excluded. Credentials that must not travel,
 *                 provider handshake state that is meaningless on another
 *                 host, ledgers whose value is that they were written here.
 *
 * Every entry carries its reason in prose. "Obvious" is not a reason: the
 * whole class of defect here is someone deciding something was obvious and
 * nobody being able to check afterwards.
 */

/** A model whose absence from a restore would lose something the account owns. */
export const BACKED_UP_MODELS = [
  // ── Measurements ──────────────────────────────────────────────────────────
  "Measurement",

  // ── Medications, and everything hanging off one ───────────────────────────
  // The parent alone restores a drug list with no schedule, no history and no
  // stock — a shape the app renders without complaint, which is why this was
  // easy to miss.
  "Medication",
  "MedicationSchedule",
  "MedicationScheduleRevision",
  "MedicationDoseChange",
  "MedicationIntakeEvent",
  "MedicationPauseEra",
  "MedicationSideEffect",
  "MedicationEfficacyTarget",
  "MedicationInventoryItem",
  "MedicationInventoryEvent",

  // ── Mood ──────────────────────────────────────────────────────────────────
  "MoodEntry",
  "MoodEntryTagLink",
  "MoodTag",
  "MoodTagCategory",
  "MoodTagHidden",

  // ── Clinical record ───────────────────────────────────────────────────────
  "MentalHealthAssessment",
  "LabResult",
  "Biomarker",
  "Allergy",
  "FamilyHistoryEntry",
  "IllnessEpisode",
  "IllnessDayLog",
  "IllnessSymptomLink",
  "EcgRecording",
  "UserHealthProfile",
  "MeasurementReminder",

  // ── Cycle ─────────────────────────────────────────────────────────────────
  "CycleProfile",
  "MenstrualCycle",
  "CycleDayLog",
  "CycleSymptom",
  "CycleSymptomLink",

  // ── Custom metrics ────────────────────────────────────────────────────────
  "CustomMetric",
  "CustomMetricEntry",

  // ── Activity and nutrition ────────────────────────────────────────────────
  "Workout",
  "WorkoutRoute",
  "WorkoutSamples",
  "NutrientIntakeDay",
  "PersonalRecord",
  "UserAchievement",

  // ── Environment ───────────────────────────────────────────────────────────
  "EnvironmentContext",
  "EnvironmentTravelLocation",

  // ── Documents ─────────────────────────────────────────────────────────────
  "InboundDocument",
  "DocumentConditionLink",
  "ExtractedFact",

  // ── Coach ─────────────────────────────────────────────────────────────────
  "CoachConversation",
  "CoachMessage",
  "CoachConversationDocument",
  "CoachFact",
  "CoachPlan",
  "CoachReminder",

  // ── Preferences and consent ───────────────────────────────────────────────
  "NotificationPreference",
  "ReminderPhaseConfig",
  "ConsentReceipt",
] as const;

/**
 * Recomputable from backed-up rows. The reason names what rebuilds it, so a
 * future reader can check the claim rather than trust it.
 */
export const DERIVED_MODELS: Readonly<Record<string, string>> = {
  MeasurementRollup:
    "A per-day, per-metric reconstruction of `Measurement`. The boot-time rollup backfill rebuilds it for an account that has none.",
  MedicationComplianceRollup:
    "Recomputed from `MedicationIntakeEvent` against the schedule by the compliance analytics tier.",
  MoodEntryRollup:
    "A per-day reconstruction of `MoodEntry`, rebuilt by the same rollup tier that rebuilds the measurement one.",
  CyclePrediction:
    "A forecast derived from `MenstrualCycle` history; regenerated on the next cycle read.",
  StrainTrimpCache:
    "A cache of a pure function over `Workout` and heart-rate samples.",
  WorkoutInsight:
    "Generated narrative over `Workout`; regenerates on demand. Carrying it would restore an interpretation of data rather than the data.",
  WorkoutInsightGenerationClaim:
    "A concurrency claim guarding the generator above. Meaningless outside the run that took it.",
  InsightNarrative:
    "Generated prose over measurements. Same reasoning as WorkoutInsight — the record restores, the essay about it does not.",
  DocumentContentIndex:
    "A search index over `InboundDocument` text; rebuilt by the indexer.",
  DocumentThumbnail:
    "Rendered from the stored document bytes on demand. Those bytes travel in a disaster-recovery payload, so the picture rebuilds itself on first view; a portable export carries metadata only, and there the thumbnail has nothing to rebuild from — but neither does the document, so nothing is lost that the export did not already disclose.",
  ArrivalReaction:
    "Derived from what changed since the last visit; recomputed per visit.",
  DismissedPriorityItem:
    "A per-item dismissal of a recomputed priority list. The list regenerates; a stale dismissal would suppress an item the new list means to raise.",
};

/**
 * Deliberately excluded, with the reason. These are the entries most likely to
 * be argued with later, so each says what it would cost to include.
 */
export const NOT_IN_BACKUP_MODELS: Readonly<Record<string, string>> = {
  // Provider credentials and handshake state.
  WithingsConnection:
    "An OAuth grant bound to this deployment's client registration. Restored elsewhere it is a dead token that makes the integration look connected while it silently fails — the exact shape of defect this release is about.",
  WithingsOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  WhoopConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  WhoopOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  WhoopConnectTicket:
    "A single-use ticket that binds one connect attempt to one browser; spent or expired long before a restore.",
  FitbitConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  FitbitOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  GoogleHealthConnection:
    "An OAuth grant bound to this deployment's client registration; on another host it is a dead token that reads as connected.",
  GoogleHealthOAuthState:
    "A CSRF nonce for a handshake that is valid for minutes and is already over by the time any backup is read.",
  McpOAuthConnection:
    "A grant issued to a client that was registered against this instance.",
  IntegrationStatus:
    "A ledger of what this deployment's syncs did. Restoring it onto another host would assert a sync history that host never had.",

  // Credentials and device identity.
  ApiToken:
    "Bearer credentials. A backup file is not a credential store, and a leaked file must not become a set of working tokens.",
  Device:
    "An APNs token identifying one install on one phone. Restored elsewhere it addresses a device that will never receive from this host.",
  PushSubscription:
    "A Web Push endpoint issued by one browser for one origin. Another host cannot send to it, and the browser that owns it re-subscribes on its own.",
  NotificationChannel:
    "Carries channel secrets (Telegram chat binding, ntfy topic). Same reasoning as ApiToken.",
  UserKnownDevice:
    "A device-recognition ledger. Restoring it would pre-trust devices on a host that has never seen them.",
  StepUpElevation:
    "Proof that a second factor was satisfied minutes ago. Carrying it would let a restored file re-grant an elevation nobody performed.",

  // Ledgers whose meaning is local to the deployment.
  PushAttempt:
    "A 90-day delivery ledger for this host's sends, and since v1.33.1 also the anchor rows the reminder dedup writes under a sentinel channel. Both describe what this instance did; restoring either onto another host would assert sends it never made, and the dedup anchors would suppress reminders that host still owes.",
  AuditLog:
    "An append-only record of actions taken on this instance. Merging one instance's audit trail into another's would make the trail untrue.",
  CoachUsage:
    "Spend metering against this operator's own AI budget. Restoring it would charge one instance's consumption against another instance's cap.",
  ProviderHealth:
    "What this host observed when it called its providers. Another host has its own network, keys and rate limits, so the observation does not transfer.",
  IdempotencyKey:
    "Replay protection for requests this host already answered. Restoring it would suppress a legitimate new request.",
  DataBackup:
    "The backup catalogue itself. A backup that contains the list of backups is a recursion with no reader.",
  ImportJob:
    "A job record pointing at an uploaded file that the backup does not carry, so restoring it would resurrect a task with nothing to work on.",
  MedicationIntakeImportJob:
    "A job record pointing at an uploaded dose-history file that is not carried in the backup, so restoring the job would resurrect a task with nothing to work on.",
  TelegramPromptContext:
    "Records which reminder a Telegram reply refers to, keyed by a message id in one chat on one bot. Meaningless against any other chat, and the conversation it belongs to is not carried either.",

  // Sharing and outbound links.
  ClinicianShareLink:
    "A live URL handed to a practice. Restoring it would resurrect a link the account may have revoked deliberately — and it points at a host that may not be this one.",
  ClinicianShareLinkDocument:
    "Names which documents a share link exposed. Without the link it grants nothing, and with it, it would re-expose files through a URL the account may have revoked.",

  // Transient notification bookkeeping.
  MoodReminderDispatch:
    "A per-day record of whether this host already sent today's prompt. The next day writes its own, and a restored one would suppress a send.",
  TelegramScheduledDeletion:
    "A pending delete addressed at message ids in one chat on one bot. Those ids mean something else, or nothing, anywhere the messages do not exist.",
  TelegramReminderMessage:
    "Message ids in one chat on one bot, used to edit or clean up a sent reminder. They address messages that a restored instance never sent.",
  RecommendationFeedback:
    "Feedback on generated recommendations that are themselves DERIVED. Restoring the feedback without the item it judged leaves an orphan.",
};

/** Auth material: not user data, and excluded from the wipe for the same reason. */
export const AUTH_MODELS_OUT_OF_SCOPE: readonly string[] = [
  "Session",
  "RefreshToken",
  "Passkey",
  "WebauthnMfaCredential",
  "MfaRecoveryCode",
  "MfaChallenge",
  "AuthChallenge",
  "TrustedDevice",
  "OidcNativeHandoff",
  "InviteRedemption",
];

export type BackupVerdict = "BACKED_UP" | "DERIVED" | "NOT_IN_BACKUP" | "AUTH";

/**
 * The verdict for a model, or `null` when the schema carries a model this file
 * has never ruled on. The guard turns that `null` into a failing test, which
 * is the whole point: a new model gets a decision, not a default.
 */
export function backupVerdict(model: string): BackupVerdict | null {
  if ((BACKED_UP_MODELS as readonly string[]).includes(model)) {
    return "BACKED_UP";
  }
  if (model in DERIVED_MODELS) return "DERIVED";
  if (model in NOT_IN_BACKUP_MODELS) return "NOT_IN_BACKUP";
  if (AUTH_MODELS_OUT_OF_SCOPE.includes(model)) return "AUTH";
  return null;
}
