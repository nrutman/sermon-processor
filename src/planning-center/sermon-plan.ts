import { z } from "zod";
import { isoDateSchema } from "../config/schema.js";
import type {
  PlanAttributes,
  PlanItemAttributes,
  PlanningCenterCollection,
  PlanningCenterReadApi,
  PlanningCenterResource,
  SeriesAttributes,
} from "./client.js";

export interface SermonPlanArtwork {
  contentType?: string;
  fileName?: string;
  fileSize?: number;
  url: string;
}

export interface SermonPlanMetadata {
  artwork?: SermonPlanArtwork;
  date: string;
  planId: string;
  planUrl?: string;
  preacher?: string;
  scripture?: string;
  sermonSeries?: string;
  title?: string;
  warnings: string[];
}

const sermonPlanLookupSchema = z.object({
  date: isoDateSchema,
  planId: z.string().trim().min(1).optional(),
  serviceTypeId: z.string().trim().min(1),
});

export type SermonPlanLookup = z.infer<typeof sermonPlanLookupSchema>;

function relationshipId(
  resource: PlanningCenterResource<unknown>,
  relationship: string,
): string | undefined {
  return resource.relationships?.[relationship]?.data?.id;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripHtml(value: string): string {
  return value
    .replaceAll(/<br\s*\/?>/gi, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&nbsp;/gi, " ")
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function itemText(item: PlanningCenterResource<PlanItemAttributes>): string | undefined {
  const description = nonempty(item.attributes.description);
  if (description) return description;
  const html = nonempty(item.attributes.html_details);
  return html ? stripHtml(html) : undefined;
}

function findSeries(
  plan: PlanningCenterResource<PlanAttributes>,
  included: PlanningCenterResource<Record<string, unknown>>[],
): string | undefined {
  const directTitle = nonempty(plan.attributes.series_title);
  if (directTitle) return directTitle;
  const seriesId = relationshipId(plan, "series");
  const series = included.find(({ id, type }) => id === seriesId && type === "Series");
  return nonempty(series?.attributes.title) ?? nonempty(series?.attributes.name);
}

function findArtwork(
  series: PlanningCenterResource<SeriesAttributes> | undefined,
): SermonPlanArtwork | undefined {
  const url = nonempty(series?.attributes.artwork_original);
  if (!series?.attributes.has_artwork || !url) return undefined;
  return {
    contentType: nonempty(series.attributes.artwork_content_type),
    fileName: nonempty(series.attributes.artwork_file_name),
    fileSize: series.attributes.artwork_file_size ?? undefined,
    url,
  };
}

function findScripture(
  items: PlanningCenterResource<PlanItemAttributes>[],
  sermonSequence?: number,
): string | undefined {
  const candidates = items.filter((item) => {
    const title = nonempty(item.attributes.title);
    return (
      title !== undefined &&
      /^scripture reading$/i.test(title) &&
      (sermonSequence === undefined || item.attributes.sequence < sermonSequence)
    );
  });
  const candidate =
    candidates.at(-1) ?? items.find((item) => /scripture/i.test(item.attributes.title ?? ""));
  return candidate ? itemText(candidate) : undefined;
}

function selectPlan(
  plans: PlanningCenterCollection<PlanAttributes>,
  date: string,
): PlanningCenterResource<PlanAttributes> {
  const matches = plans.data.filter(({ attributes }) => attributes.sort_date.startsWith(date));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `No Planning Center plan exists on ${date}`
        : `Multiple Planning Center plans exist on ${date}; pass --plan-id`,
    );
  }
  return matches[0]!;
}

function dayBeforeIsoDate(date: string): string {
  const dayBefore = new Date(`${date}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  return dayBefore.toISOString();
}

/** Reads one service plan and maps available fields into sermon metadata. */
export async function readSermonPlanMetadata(
  client: PlanningCenterReadApi,
  rawLookup: SermonPlanLookup,
): Promise<SermonPlanMetadata> {
  const lookup = sermonPlanLookupSchema.parse(rawLookup);
  const planCollection = lookup.planId
    ? await client.getPlan(lookup.serviceTypeId, lookup.planId)
    : await client.listPlans(lookup.serviceTypeId, dayBeforeIsoDate(lookup.date));
  const plan = lookup.planId ? planCollection.data[0] : selectPlan(planCollection, lookup.date);
  if (!plan) throw new Error(`Planning Center did not return Plan ${lookup.planId}`);
  if (!plan.attributes.sort_date.startsWith(lookup.date)) {
    throw new Error(`Planning Center Plan ${plan.id} is not scheduled on ${lookup.date}`);
  }

  const seriesId = relationshipId(plan, "series");
  const [itemCollection, peopleCollection, series] = await Promise.all([
    client.listPlanItems(lookup.serviceTypeId, plan.id),
    client.listPlanPeople(lookup.serviceTypeId, plan.id),
    seriesId ? client.getSeries(seriesId) : Promise.resolve(undefined),
  ]);
  const items = itemCollection.data.toSorted(
    (left, right) => left.attributes.sequence - right.attributes.sequence,
  );
  const sermonItem = items.find(({ attributes }) =>
    /^sermon$/i.test(attributes.title?.trim() ?? ""),
  );
  const preachers = peopleCollection.data
    .filter(({ attributes }) => /^preacher$/i.test(attributes.team_position_name?.trim() ?? ""))
    .filter(({ attributes }) => attributes.status.toLowerCase() !== "declined")
    .map(({ attributes }) => attributes.name.trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);
  const warnings: string[] = [];
  if (preachers.length > 1)
    warnings.push(`Multiple preachers are scheduled: ${preachers.join(", ")}`);

  const metadata: SermonPlanMetadata = {
    artwork: findArtwork(series),
    date: lookup.date,
    planId: plan.id,
    planUrl: nonempty(plan.attributes.planning_center_url) ?? plan.links?.html,
    preacher: preachers.length === 1 ? preachers[0] : undefined,
    scripture: findScripture(items, sermonItem?.attributes.sequence),
    sermonSeries: nonempty(series?.attributes.title) ?? findSeries(plan, planCollection.included),
    title: (sermonItem ? itemText(sermonItem) : undefined) ?? nonempty(plan.attributes.title),
    warnings,
  };
  for (const field of ["preacher", "sermonSeries", "scripture", "title", "artwork"] as const) {
    if (field === "preacher" && preachers.length > 1) continue;
    if (!metadata[field]) warnings.push(`Planning Center did not provide ${field}`);
  }
  return metadata;
}
