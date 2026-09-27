import { prisma } from "@/lib/db";
import { MEDICATION_CATEGORY_VALUES } from "@/lib/validations/medication";

const MEDICATION_CATEGORIES = MEDICATION_CATEGORY_VALUES;

export type MedicationCategory = (typeof MEDICATION_CATEGORIES)[number];

const DEFAULT_CATEGORY: MedicationCategory = "OTHER";

/**
 * The raw-SQL surface the helpers below need. The default is the shared
 * client; the backup builder and the restore pass their own (the restore's
 * transaction client, so a category row lands in the same transaction as
 * the medication it points at and its foreign key can see that row).
 */
type RawSqlClient = Pick<
  typeof prisma,
  "$queryRawUnsafe" | "$executeRawUnsafe"
>;

let ensureTablePromise: Promise<void> | null = null;

function normalizeCategory(input: unknown): MedicationCategory {
  if (typeof input !== "string") return DEFAULT_CATEGORY;
  return MEDICATION_CATEGORIES.includes(input as MedicationCategory)
    ? (input as MedicationCategory)
    : DEFAULT_CATEGORY;
}

export async function ensureMedicationCategoryTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS medication_categories (
          medication_id TEXT PRIMARY KEY REFERENCES medications(id) ON DELETE CASCADE,
          category TEXT NOT NULL DEFAULT 'OTHER',
          updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS medication_categories_category_idx
        ON medication_categories(category);
      `);
    })().catch((err) => {
      ensureTablePromise = null;
      throw err;
    });
  }

  await ensureTablePromise;
}

export async function getMedicationCategories(
  medicationIds: string[],
  client: RawSqlClient = prisma,
): Promise<Record<string, MedicationCategory>> {
  if (medicationIds.length === 0) return {};
  await ensureMedicationCategoryTable();

  const rows = await client.$queryRawUnsafe<
    Array<{ medication_id: string; category: string }>
  >(
    `
      SELECT medication_id, category
      FROM medication_categories
      WHERE medication_id = ANY($1::text[])
    `,
    medicationIds,
  );

  const map: Record<string, MedicationCategory> = {};
  for (const id of medicationIds) {
    map[id] = DEFAULT_CATEGORY;
  }
  for (const row of rows) {
    map[row.medication_id] = normalizeCategory(row.category);
  }
  return map;
}

export async function setMedicationCategory(
  medicationId: string,
  category: unknown,
  client: RawSqlClient = prisma,
) {
  await ensureMedicationCategoryTable();
  const normalized = normalizeCategory(category);

  await client.$executeRawUnsafe(
    `
      INSERT INTO medication_categories (medication_id, category, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (medication_id)
      DO UPDATE SET category = EXCLUDED.category, updated_at = NOW()
    `,
    medicationId,
    normalized,
  );

  return normalized;
}

export async function deleteMedicationCategory(medicationId: string) {
  await ensureMedicationCategoryTable();
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_categories WHERE medication_id = $1`,
    medicationId,
  );
}
