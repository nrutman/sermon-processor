import { z } from "zod";
import { loadEnvironmentConfiguration, type EnvironmentLoadOptions } from "./environment.js";

export const planningCenterConfigSchema = z
  .object({
    clientId: z.string().trim().min(1),
    secret: z.string().trim().min(1),
    userAgent: z.string().trim().min(1),
    defaultServiceTypeId: z.string().trim().min(1).optional(),
  })
  .strict();

const planningCenterEnvironmentSchema = z.object({
  PLANNING_CENTER_CLIENT_ID: z.string().trim().min(1),
  PLANNING_CENTER_SECRET: z.string().trim().min(1),
  PLANNING_CENTER_USER_AGENT: z.string().trim().min(1),
  PLANNING_CENTER_DEFAULT_SERVICE_TYPE_ID: z.string().trim().min(1).optional(),
});

export type PlanningCenterConfig = z.infer<typeof planningCenterConfigSchema>;

/** Loads read-only Planning Center API credentials and the optional default Service Type. */
export async function loadPlanningCenterConfig(
  options: EnvironmentLoadOptions = {},
): Promise<PlanningCenterConfig> {
  const environment = planningCenterEnvironmentSchema.parse(
    await loadEnvironmentConfiguration(options),
  );
  return planningCenterConfigSchema.parse({
    clientId: environment.PLANNING_CENTER_CLIENT_ID,
    secret: environment.PLANNING_CENTER_SECRET,
    userAgent: environment.PLANNING_CENTER_USER_AGENT,
    defaultServiceTypeId: environment.PLANNING_CENTER_DEFAULT_SERVICE_TYPE_ID,
  });
}
