import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlanningCenterConfig } from "../planning-center-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Planning Center configuration", () => {
  it("loads credentials and the default Service Type from .env.local", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planning-center-config-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, ".env.local"),
      [
        "PLANNING_CENTER_CLIENT_ID=client",
        "PLANNING_CENTER_SECRET=secret",
        "PLANNING_CENTER_USER_AGENT=Sermon Processor (test@example.com)",
        "PLANNING_CENTER_DEFAULT_SERVICE_TYPE_ID=service-1",
      ].join("\n"),
    );

    await expect(loadPlanningCenterConfig({ directory, environment: {} })).resolves.toEqual({
      clientId: "client",
      secret: "secret",
      userAgent: "Sermon Processor (test@example.com)",
      defaultServiceTypeId: "service-1",
    });
  });

  it("does not require a default Service Type when the CLI supplies one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planning-center-config-"));
    temporaryDirectories.push(directory);

    await expect(
      loadPlanningCenterConfig({
        directory,
        environment: {
          PLANNING_CENTER_CLIENT_ID: "client",
          PLANNING_CENTER_SECRET: "secret",
          PLANNING_CENTER_USER_AGENT: "Sermon Processor (test@example.com)",
        },
      }),
    ).resolves.toEqual({
      clientId: "client",
      secret: "secret",
      userAgent: "Sermon Processor (test@example.com)",
    });
  });
});
