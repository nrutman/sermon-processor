import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../cli.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("plan-metadata command", () => {
  it("prints metadata read through the Planning Center client", async () => {
    vi.stubEnv("PLANNING_CENTER_CLIENT_ID", "client");
    vi.stubEnv("PLANNING_CENTER_SECRET", "secret");
    vi.stubEnv("PLANNING_CENTER_USER_AGENT", "Sermon Processor (test@example.com)");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/plans?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "plan-1",
                type: "Plan",
                attributes: {
                  planning_center_url: "https://example.com/plan-1",
                  sort_date: "2026-08-30T09:30:00Z",
                  title: "Root and Fruit",
                },
                relationships: { series: { data: { id: "series-1", type: "Series" } } },
              },
            ],
          }),
        );
      }
      if (url.endsWith("/series/series-1")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "series-1",
              type: "Series",
              attributes: {
                artwork_content_type: "image/png",
                artwork_original: "https://example.com/art.png",
                has_artwork: true,
                title: "Sermon on the Mount",
              },
            },
          }),
        );
      }
      if (url.includes("/items?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "scripture",
                type: "Item",
                attributes: {
                  description: "Matthew 7:13–23",
                  item_type: "item",
                  sequence: 1,
                  title: "Scripture Reading",
                },
              },
            ],
          }),
        );
      }
      if (url.includes("/team_members?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "preacher",
                type: "PlanPerson",
                attributes: {
                  name: "Robert Ivy",
                  status: "confirmed",
                  team_position_name: "Preacher",
                },
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected Planning Center request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await createProgram().parseAsync(
      ["plan-metadata", "--date", "2026-08-30", "--service-type", "service-1", "--json"],
      { from: "user" },
    );

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      artwork: { contentType: "image/png", url: "https://example.com/art.png" },
      date: "2026-08-30",
      preacher: "Robert Ivy",
      scripture: "Matthew 7:13–23",
      sermonSeries: "Sermon on the Mount",
      title: "Root and Fruit",
      warnings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
