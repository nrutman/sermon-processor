import type { PlanningCenterConfig } from "../config/planning-center-config.js";

const servicesBaseUrl = "https://api.planningcenteronline.com/services/v2";

export interface PlanningCenterResource<Attributes> {
  id: string;
  type: string;
  attributes: Attributes;
  links?: Record<string, string>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

interface CollectionResponse<Attributes> {
  data: PlanningCenterResource<Attributes>[];
  included?: PlanningCenterResource<Record<string, unknown>>[];
  links?: { next?: string | null };
}

interface ResourceResponse<Attributes> {
  data: PlanningCenterResource<Attributes>;
  included?: PlanningCenterResource<Record<string, unknown>>[];
}

export interface PlanAttributes {
  planning_center_url?: string;
  series_title?: string | null;
  sort_date: string;
  title?: string | null;
}

export interface PlanItemAttributes {
  description?: string | null;
  html_details?: string | null;
  item_type: string;
  sequence: number;
  title?: string | null;
}

export interface PlanPersonAttributes {
  name: string;
  status: string;
  team_position_name?: string | null;
}

export interface SeriesAttributes {
  artwork_content_type?: string | null;
  artwork_file_name?: string | null;
  artwork_file_size?: number | null;
  artwork_original?: string | null;
  has_artwork: boolean;
  title: string;
}

export interface PlanningCenterCollection<Attributes> {
  data: PlanningCenterResource<Attributes>[];
  included: PlanningCenterResource<Record<string, unknown>>[];
}

export interface PlanningCenterReadApi {
  getPlan(serviceTypeId: string, planId: string): Promise<PlanningCenterCollection<PlanAttributes>>;
  listPlanItems(
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanningCenterCollection<PlanItemAttributes>>;
  listPlanPeople(
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanningCenterCollection<PlanPersonAttributes>>;
  listPlans(
    serviceTypeId: string,
    after: string,
  ): Promise<PlanningCenterCollection<PlanAttributes>>;
  getSeries(seriesId: string): Promise<PlanningCenterResource<SeriesAttributes>>;
}

export class PlanningCenterClient implements PlanningCenterReadApi {
  private readonly authorization: string;
  private readonly userAgent: string;

  constructor(config: PlanningCenterConfig) {
    this.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`;
    this.userAgent = config.userAgent;
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(path.startsWith("http") ? path : `${servicesBaseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: this.authorization,
        "User-Agent": this.userAgent,
      },
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Planning Center request failed (${response.status} ${response.statusText}): ${detail}`,
      );
    }
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- The private call sites bind T to the documented JSON:API endpoint response.
    return (await response.json()) as T;
  }

  private async collection<Attributes>(
    path: string,
  ): Promise<PlanningCenterCollection<Attributes>> {
    const data: PlanningCenterResource<Attributes>[] = [];
    const included = new Map<string, PlanningCenterResource<Record<string, unknown>>>();
    let nextPath: string | null | undefined = path;
    while (nextPath) {
      // Pagination is sequential because Planning Center supplies the next request URL in each response.
      let response: CollectionResponse<Attributes>;
      // eslint-disable-next-line no-await-in-loop
      response = await this.request<CollectionResponse<Attributes>>(nextPath);
      data.push(...response.data);
      for (const resource of response.included ?? []) {
        included.set(`${resource.type}:${resource.id}`, resource);
      }
      nextPath = response.links?.next;
    }
    return { data, included: [...included.values()] };
  }

  listPlans(
    serviceTypeId: string,
    after: string,
  ): Promise<PlanningCenterCollection<PlanAttributes>> {
    const query = new URLSearchParams({
      after,
      filter: "after",
      include: "series",
      order: "sort_date",
      per_page: "100",
    });
    return this.collection(`/service_types/${serviceTypeId}/plans?${query.toString()}`);
  }

  async getPlan(
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanningCenterCollection<PlanAttributes>> {
    const response = await this.request<ResourceResponse<PlanAttributes>>(
      `/service_types/${serviceTypeId}/plans/${planId}?include=series`,
    );
    return { data: [response.data], included: response.included ?? [] };
  }

  async getSeries(seriesId: string): Promise<PlanningCenterResource<SeriesAttributes>> {
    const response = await this.request<ResourceResponse<SeriesAttributes>>(`/series/${seriesId}`);
    return response.data;
  }

  listPlanItems(
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanningCenterCollection<PlanItemAttributes>> {
    return this.collection(
      `/service_types/${serviceTypeId}/plans/${planId}/items?order=sequence&per_page=100`,
    );
  }

  listPlanPeople(
    serviceTypeId: string,
    planId: string,
  ): Promise<PlanningCenterCollection<PlanPersonAttributes>> {
    return this.collection(
      `/service_types/${serviceTypeId}/plans/${planId}/team_members?per_page=100`,
    );
  }
}
