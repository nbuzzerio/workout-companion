import { z } from 'zod';

export const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const appConfigSchema = z
  .object({
    id: z.string().max(48).regex(slugPattern),
    displayName: z.string().trim().min(1).max(80),
    basePath: z.string(),
    databaseName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
    sync: z
      .object({ enabled: z.literal(false), endpoint: z.url().optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.basePath !== `/apps/${value.id}/`) {
      context.addIssue({
        code: 'custom',
        path: ['basePath'],
        message: 'Expected /apps/{id}/ with a trailing slash',
      });
    }
  });

// Existing Workout identity: databaseName must stay compatible with W-01.
export const appConfig = appConfigSchema.parse({
  id: 'workout',
  displayName: 'Workout Companion',
  basePath: '/apps/workout/',
  databaseName: 'workout-companion',
  // Build-time configuration cannot opt users in. Consent lives in IndexedDB.
  // Requests always use same-origin /api/v1; this optional URL is legacy metadata.
  sync: { enabled: false },
});
