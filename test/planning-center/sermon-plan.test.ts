import { describe, expect, it, vi } from "vitest";
import type {
  PlanningCenterReadApi,
  PlanningCenterResource,
} from "../../src/planning-center/client.js";
import { readSermonPlanMetadata } from "../../src/planning-center/sermon-plan.js";

function resource<Attributes>(
  type: string,
  id: string,
  attributes: Attributes,
): PlanningCenterResource<Attributes> {
  return { type, id, attributes };
}

function api(overrides: Partial<PlanningCenterReadApi> = {}): PlanningCenterReadApi {
  const plan = {
    ...resource("Plan", "plan-1", {
      planning_center_url: "https://services.planningcenteronline.com/plans/plan-1",
      series_title: null,
      sort_date: "2026-08-30T09:30:00Z",
      title: "Plan title",
    }),
    relationships: { series: { data: { type: "Series", id: "series-1" } } },
  };
  return {
    getPlan: vi.fn<PlanningCenterReadApi["getPlan"]>().mockResolvedValue({
      data: [plan],
      included: [],
    }),
    listPlans: vi.fn<PlanningCenterReadApi["listPlans"]>().mockResolvedValue({
      data: [plan],
      included: [],
    }),
    listPlanItems: vi.fn<PlanningCenterReadApi["listPlanItems"]>().mockResolvedValue({
      data: [
        resource("Item", "scripture", {
          description: "Matthew 7:13–23",
          item_type: "item",
          sequence: 14,
          title: "Scripture Reading",
        }),
        resource("Item", "sermon", {
          description: "Root and Fruit",
          item_type: "item",
          sequence: 15,
          title: "Sermon",
        }),
        resource("Item", "response", {
          description: "2 Corinthians 5:17",
          item_type: "item",
          sequence: 22,
          title: "Scripture Reading and Response",
        }),
      ],
      included: [],
    }),
    listPlanPeople: vi.fn<PlanningCenterReadApi["listPlanPeople"]>().mockResolvedValue({
      data: [
        resource("PlanPerson", "person-1", {
          name: "Robert Ivy",
          status: "confirmed",
          team_position_name: "Preacher",
        }),
      ],
      included: [],
    }),
    getSeries: vi.fn<PlanningCenterReadApi["getSeries"]>().mockResolvedValue(
      resource("Series", "series-1", {
        artwork_content_type: "image/png",
        artwork_file_name: "series-art.png",
        artwork_file_size: 50_382,
        artwork_original: "https://example.com/series-art.png",
        has_artwork: true,
        title: "Sermon on the Mount",
      }),
    ),
    ...overrides,
  };
}

describe("readSermonPlanMetadata", () => {
  it("maps the sermon section, preacher assignment, Series, and artwork", async () => {
    await expect(
      readSermonPlanMetadata(api(), {
        date: "2026-08-30",
        serviceTypeId: "service-1",
      }),
    ).resolves.toEqual({
      artwork: {
        contentType: "image/png",
        fileName: "series-art.png",
        fileSize: 50_382,
        url: "https://example.com/series-art.png",
      },
      date: "2026-08-30",
      planId: "plan-1",
      planUrl: "https://services.planningcenteronline.com/plans/plan-1",
      preacher: "Robert Ivy",
      scripture: "Matthew 7:13–23",
      sermonSeries: "Sermon on the Mount",
      title: "Root and Fruit",
      warnings: [],
    });
  });

  it("reports fields that the plan does not provide", async () => {
    const emptyApi = api({
      listPlanItems: vi
        .fn<PlanningCenterReadApi["listPlanItems"]>()
        .mockResolvedValue({ data: [], included: [] }),
      listPlanPeople: vi
        .fn<PlanningCenterReadApi["listPlanPeople"]>()
        .mockResolvedValue({ data: [], included: [] }),
      getSeries: vi.fn<PlanningCenterReadApi["getSeries"]>().mockResolvedValue(
        resource("Series", "series-1", {
          has_artwork: false,
          title: "Sermon on the Mount",
        }),
      ),
    });

    const result = await readSermonPlanMetadata(emptyApi, {
      date: "2026-08-30",
      serviceTypeId: "service-1",
    });

    expect(result).toMatchObject({
      preacher: undefined,
      scripture: undefined,
      sermonSeries: "Sermon on the Mount",
      title: "Plan title",
    });
    expect(result.warnings).toEqual([
      "Planning Center did not provide preacher",
      "Planning Center did not provide scripture",
      "Planning Center did not provide artwork",
    ]);
  });

  it("requires an explicit Plan ID when a date has multiple plans", async () => {
    const duplicatePlanApi = api();
    const first = resource("Plan", "plan-1", { sort_date: "2026-08-30T09:30:00Z" });
    duplicatePlanApi.listPlans = vi
      .fn<PlanningCenterReadApi["listPlans"]>()
      .mockResolvedValue({ data: [first, { ...first, id: "plan-2" }], included: [] });

    await expect(
      readSermonPlanMetadata(duplicatePlanApi, {
        date: "2026-08-30",
        serviceTypeId: "service-1",
      }),
    ).rejects.toThrow("Multiple Planning Center plans exist");
  });

  it("reports multiple scheduled preachers instead of selecting one", async () => {
    const multiplePreacherApi = api({
      listPlanPeople: vi.fn<PlanningCenterReadApi["listPlanPeople"]>().mockResolvedValue({
        data: [
          resource("PlanPerson", "person-1", {
            name: "First Preacher",
            status: "confirmed",
            team_position_name: "Preacher",
          }),
          resource("PlanPerson", "person-2", {
            name: "Second Preacher",
            status: "unconfirmed",
            team_position_name: "Preacher",
          }),
        ],
        included: [],
      }),
    });

    const result = await readSermonPlanMetadata(multiplePreacherApi, {
      date: "2026-08-30",
      serviceTypeId: "service-1",
    });

    expect(result.preacher).toBeUndefined();
    expect(result.warnings).toEqual([
      "Multiple preachers are scheduled: First Preacher, Second Preacher",
    ]);
  });
});
