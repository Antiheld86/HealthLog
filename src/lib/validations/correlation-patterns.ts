import { z } from "zod/v4";

export const updateCorrelationPatternSchema = z.strictObject({
  dismissed: z.boolean(),
});

export type UpdateCorrelationPatternInput = z.infer<
  typeof updateCorrelationPatternSchema
>;
