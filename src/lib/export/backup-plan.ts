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
 *                 Split in two below, because "must be carried" and "is
 *                 carried" are different claims and this file used to make
 *                 only the first. {@link TWO_ENDED_MODELS} names the models
 *                 with BOTH a payload reader and a restore branch, checked by
 *                 the guard beside this file. {@link COVERAGE_PENDING} names
 *                 the rest, each with what an account loses meanwhile.
 *
 *                 An earlier draft of this comment claimed the two-ended guard
 *                 in the present tense. It did not exist then. That is the same
 *                 defect this file was written to prevent, so it is recorded
 *                 rather than quietly corrected — and it is why the guard now
 *                 reads the source rather than trusting a list.
 *
 *                 Reading the source is still not the same as watching the data
 *                 move: a restore branch wrapped in `if (false)` reads exactly
 *                 like one that works. So the claim is settled end to end in
 *                 `tests/integration/backup-round-trip.test.ts`, which seeds a
 *                 row of every model named here, exports it, deletes the
 *                 account and counts the row back out of the real restore.
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
  // Not derived, despite looking it. The hourly shape of a cumulative day is
  // folded out of the per-sample rows in the same transaction that deletes
  // them, so past the 36-hour grace window there is nothing left to rebuild it
  // from. A restore without it silently resets the same-time baseline to
  // "still learning" for two weeks.
  "IntradayCumulativeProfile",

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
  "MoodContext",
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
  "HealthProfileFactRevision",
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
  "CorrelationPattern",
  // Reads like a derived tier and is not one. The live computation always
  // answers for today from today's rows, so once the readings behind a past
  // day have been corrected, re-synced or simply grown, nothing can reproduce
  // what that day said. The row is the only copy of the number the account
  // actually saw, which is exactly the test for BACKED_UP rather than DERIVED.
  "HealthScoreRecord",

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

  // ── Visits ────────────────────────────────────────────────────────────────
  "Practitioner",
  "Encounter",
  "EncounterDocumentLink",
  "EncounterLabLink",
  "EncounterConditionLink",

  // ── Vaccinations ──────────────────────────────────────────────────────────
  // An immunization history is the one part of a health record that has no
  // other copy: the paper Pass is the original, and once it has been
  // transcribed the transcription is what the person relies on. Nothing
  // re-syncs it from a provider.
  "VaccinationRecord",
  "VaccinationDocumentLink",

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
 * The files that carry a backed-up model OUT of the database, and the files
 * that put one back.
 *
 * Declared rather than discovered, because discovery is what keeps going
 * wrong here. A previous review grepped the restore ROUTE, concluded the cycle
 * data was never restored, and had to retract it publicly: the route delegates
 * to `restoreCycleData`, and a grep of the route alone lies. The profile and
 * custom-metric pair added later delegates the same way, on purpose.
 *
 * Keeping both lists here means a new section has to say where its two ends
 * live, and the guard reads those files instead of guessing which ones matter.
 */
export const BACKUP_WRITER_FILES: readonly string[] = [
  "src/lib/export/full-backup-payload.ts",
  // Measurements are read through this pager, not directly. The guard caught
  // its absence from this list on the first run — the same "the caller
  // delegates" mistake the list exists to prevent, made while writing the list.
  "src/lib/export/paged-measurements.ts",
  "src/lib/export/records-backup.ts",
  // The illness day-log's symptom include is a shared constant living here,
  // not a literal in the records writer. Same "the caller delegates" shape as
  // the measurement pager above, found the same way: by a check that stopped
  // accepting one model's relation write as proof about another's.
  "src/lib/illness/dto.ts",
  "src/lib/export/profile-backup.ts",
  "src/lib/export/intraday-profile-backup.ts",
  "src/lib/export/health-score-backup.ts",
  // Visits, the address book and the three link tables. Each model reads
  // through its OWN delegate here rather than riding a relation, because
  // `documentLinks` is a field name on two different models and a
  // relation-shaped proof would be attributed to whichever one a matcher found
  // first — the `symptomLinks` confusion, avoided by construction.
  "src/lib/export/visits-backup.ts",
  "src/lib/cycle/backup.ts",
];

export const BACKUP_RESTORE_FILES: readonly string[] = [
  "src/app/api/admin/backups/[id]/restore/route.ts",
  "src/lib/export/profile-backup.ts",
  "src/lib/export/intraday-profile-backup.ts",
  "src/lib/export/health-score-backup.ts",
  "src/lib/export/visits-backup.ts",
  "src/lib/cycle/backup.ts",
];

/**
 * Backed-up models that genuinely travel BOTH ways.
 *
 * The guard checks each of these against the files above: a read in a writer
 * file and a write in a restore file, counting a relation carried inside its
 * parent (`include: { schedules: true }` out, `schedules: { create: … }` back)
 * as covered, because that is how the child rows actually ride.
 *
 * A model moves onto this list when its two ends land, never before. That is
 * the whole point of the split — a verdict of `BACKED_UP` is an intention, and
 * an intention is what the nutrient day totals had while a restore was throwing
 * them away and reporting success.
 *
 * Frozen as a literal tuple so {@link TwoEndedModel} can key the round-trip
 * test's seed registry. Adding a name here without seeding a row for it is then
 * a compile error rather than a silently unproven claim.
 */
export const TWO_ENDED_MODELS = [
  "Measurement",
  "IntradayCumulativeProfile",
  "Medication",
  "MedicationSchedule",
  "MedicationIntakeEvent",
  "MedicationSideEffect",
  "MoodEntry",
  "MoodContext",
  "MoodEntryTagLink",
  "MoodTag",
  "LabResult",
  "Biomarker",
  "Allergy",
  "FamilyHistoryEntry",
  "IllnessEpisode",
  "IllnessDayLog",
  "IllnessSymptomLink",
  "UserHealthProfile",
  "HealthProfileFactRevision",
  "CycleProfile",
  "MenstrualCycle",
  "CycleDayLog",
  "CycleSymptom",
  "CycleSymptomLink",
  "CustomMetric",
  "CustomMetricEntry",
  "CorrelationPattern",
  "HealthScoreRecord",
  "Workout",
  "NutrientIntakeDay",
  "InboundDocument",
  // Visits travel both ways from the release that introduces them. Two
  // COVERAGE_PENDING neighbours already say what the alternative costs:
  // reminders restore silent, and the filing between documents and conditions
  // is lost. Leaving the visit links pending would return visits and documents
  // with nothing between them — the same loss, one layer deeper — so the links
  // land carried rather than owed.
  "Practitioner",
  "Encounter",
  "EncounterDocumentLink",
  "EncounterLabLink",
  "EncounterConditionLink",
  // Doses travel both ways from the release that introduces them, and the
  // link with them. `DocumentConditionLink` one list down says what the
  // alternative costs — documents and conditions both restore, the filing
  // between them does not. Repeating that here would return a restored
  // Impfpass scan and a restored dose with nothing between them, which is the
  // same regret against a record a person cannot reconstruct from anywhere
  // else.
  "VaccinationRecord",
  "VaccinationDocumentLink",
] as const;

/** One model claimed to travel both ways. */
export type TwoEndedModel = (typeof TWO_ENDED_MODELS)[number];

/**
 * Two-ended models whose coverage the structural check cannot ATTRIBUTE, with
 * the reason each defeats it.
 *
 * Not an exemption from being carried — every model here is carried, and the
 * round-trip test proves it by seeding a row, exporting, emptying the account
 * and reading the row back out of the restore. It is an exemption from being
 * proven by reading source text, and it exists so the limit is written down in
 * one place instead of showing up as a green check that means nothing.
 *
 * A model earns a line here only when a same-file grep genuinely cannot tell
 * two tables apart. The guard beside this file checks that each one is covered
 * by the round trip, so naming a model here moves the burden of proof rather
 * than dropping it.
 */
export const STRUCTURALLY_UNATTRIBUTABLE: Readonly<Record<string, string>> = {
  IllnessSymptomLink:
    "Read out through `dayLogSymptomInclude`, a shared include constant in `src/lib/illness/dto.ts` that names `symptomLinks` with no query beside it. `symptomLinks` is also `CycleDayLog`'s field for `CycleSymptomLink`, so the name alone cannot say which table a line is about, and the parent that would disambiguate it — `IllnessDayLog` — is reached transitively through the episode's `dayLogs` include in another file. Deleting the illness branch from the restore route left the old check green on the strength of the cycle write; the round trip is what notices now.",
};

/**
 * Backed-up models that do NOT travel yet, each with what an account loses
 * until it does.
 *
 * This is a debt register, not a design. Every line is a restore that comes
 * back short without saying so, which is the failure mode the whole file
 * exists to make visible. The reasons say what goes missing rather than
 * "not yet", so the next person can order the work by what it costs a person
 * rather than by what is cheapest to write.
 */
export const COVERAGE_PENDING: Readonly<Record<string, string>> = {
  MedicationScheduleRevision:
    "The history of how a schedule changed. Without it a restored medication keeps today's schedule and loses the record of when the dose or timing moved, which is the part a doctor asks about.",
  MedicationDoseChange:
    "Titration history — when a dose went up or down and by how much. A restore rebuilds the current dose and drops the ramp that led to it.",
  MedicationPauseEra:
    "The spans where a medication was deliberately paused. Without them the compliance recomputation counts a deliberate pause as missed doses and the restored account looks non-adherent.",
  MedicationEfficacyTarget:
    "What a medication was supposed to move, and by how much. The drug comes back with no statement of what it was for.",
  MedicationInventoryItem:
    "Pack sizes and remaining stock. A restored account reports no supply and every low-stock reminder has to be reconstructed by hand.",
  MedicationInventoryEvent:
    "The ledger of refills and consumption behind the stock count. Without it the count above cannot be rebuilt even in principle.",
  MoodTagCategory:
    "Categories a person created to group their own mood factors. Custom tags restore into a grouping that no longer exists.",
  MoodTagHidden:
    "Which seeded mood tags the account chose to hide. A restore un-hides every one, so the mood editor comes back cluttered with tags the person removed on purpose.",
  MentalHealthAssessment:
    "Completed WHO-5, PHQ and GAD instruments with their scores and dates. Clinically meaningful history that no integration can re-sync, and the single largest gap on this list.",
  EcgRecording:
    "ECG traces and their rhythm classification. The originating device may still hold them, but a self-hoster who exported and wiped has nothing to re-sync from.",
  MeasurementReminder:
    "Per-metric reminder cadences the person configured. A restore leaves the account silent until each one is set up again.",
  WorkoutRoute:
    "GPS traces. Deliberately absent from the payload today and DISCLOSED as absent in the file's own manifest, which is why this is a documented exclusion rather than a silent one — but it is still a loss for a self-hoster with no other copy.",
  WorkoutSamples:
    "Per-sample heart-rate and pace series behind a workout summary. Same disclosed-exclusion status as the routes above, same cost.",
  PersonalRecord:
    "Bests the account accumulated. Recomputable in principle from measurements and workouts, but nothing recomputes them today, so in practice they are lost.",
  UserAchievement:
    "Milestones the account earned, with the date each was reached. The date is the part that cannot be recovered.",
  EnvironmentContext:
    "Per-day environmental readings joined to the record. Re-fetchable for recent days only; older history is gone once the provider window closes.",
  EnvironmentTravelLocation:
    "Where the person was on a given day, which is what makes the environmental readings mean anything. Never re-derivable.",
  DocumentConditionLink:
    "Which documents were filed against which condition. Documents and conditions both restore; the filing between them does not, so a restored vault is unsorted.",
  ExtractedFact:
    "Facts read out of a document by the AI pass, with their provenance back to the page. Re-derivable only by re-running the extraction against a provider, at the operator's cost.",
  CoachConversation:
    "The thread structure of past coaching conversations — which messages belong together and what each exchange was about. Without it the messages below, if they were ever carried, would restore as one undifferentiated pile.",
  CoachMessage:
    "The messages themselves, encrypted at rest. The largest volume of free text an account owns after its documents.",
  CoachConversationDocument:
    "Which documents a conversation was grounded in — the provenance that makes an old answer checkable.",
  CoachFact:
    "Durable facts the Coach was told to remember. A restore makes the account re-tell its history.",
  CoachPlan:
    "An agreed plan and its progress. Restoring the conversation without the plan keeps the talk and loses the commitment.",
  CoachReminder:
    "Reminders the Coach agreed to send. A restored account silently stops sending them.",
  NotificationPreference:
    "Per-event channel and quiet-hours choices. A restore reverts to defaults, so an account that had deliberately silenced a category starts being notified again.",
  ReminderPhaseConfig:
    "Custom reminder phase timings. Same shape of loss as the preferences above.",
  ConsentReceipt:
    "The record of what the account agreed to and when. Arguably belongs with the instance rather than the account, and that question has to be settled before this one can be carried either way.",
};

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
    "A 90-day delivery ledger for this host's sends. Restoring it onto another host would assert sends it never made.",
  NotificationEvent:
    "A local notification dedup anchor. Restoring it onto another host would suppress reminders and safety notices that host still owes.",
  NotificationEgressAuthorization:
    "A short-lived, deployment-local Guardian egress ledger. It retains no notification content, credentials, or deduplication key, and its outcome is observation rather than authorization; restoring it would nevertheless carry stale send history to a host that must recheck the live grant before every send. Exclude it so a backup never exports notification-derived privacy metadata or makes a restored host reason from another host's delivery work.",
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
  InviteToken:
    "The instance's registration ledger, minted by the operator rather than by the person, and already declared instance-scoped by the wipe plan. Restoring one account's backup must not re-open a registration code the operator retired, and the creator relation is the only thing that makes this look account-scoped at all. It surfaced here when the classification check learned to read a relation by type instead of by field name.",
  MedicationIntakeImportJob:
    "A job record pointing at an uploaded dose-history file that is not carried in the backup, so restoring the job would resurrect a task with nothing to work on.",
  TelegramPromptContext:
    "Records which reminder a Telegram reply refers to, keyed by a message id in one chat on one bot. Meaningless against any other chat, and the conversation it belongs to is not carried either.",

  // Sharing and outbound links.
  AccountGrant:
    "Live authorization over another person's health record. A backup is a snapshot of DATA, and rolling data back is a decision the owner's admin makes; rolling an authorization back is a decision nobody makes — the grant an owner revoked on Tuesday would come back alive out of Monday's file, silently, with no notification and nobody aware that access resumed. Every credential-shaped row in this file is excluded for that reason (ApiToken, TrustedDevice, StepUpElevation, UserKnownDevice) and a share link for the closest one (ClinicianShareLink). The cost is stated rather than hidden: after a disaster restore, sharing is OFF and the owner has to invite again and the delegate has to accept again. That is the fail-safe direction — access lost, never access resumed — and re-consenting after a restore is the correct amount of ceremony for handing someone your health record a second time.",
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
