#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { buildConfiguredOutputPath, loadSermonConfig } from "./config/output-config.js";
import { loadPlanningCenterConfig } from "./config/planning-center-config.js";
import { processRequestSchema, sermonMetadataSchema } from "./config/schema.js";
import { PlanningCenterClient } from "./planning-center/client.js";
import { readSermonPlanMetadata } from "./planning-center/sermon-plan.js";
import { processSermon } from "./process/process-sermon.js";

interface ProcessCommandOptions {
  artwork: string;
  date: string;
  keepWorkFiles: boolean;
  output?: string;
  overwrite: boolean;
  preacher: string;
  scripture: string;
  series: string;
  title?: string;
}

interface PlanMetadataCommandOptions {
  date: string;
  json: boolean;
  planId?: string;
  serviceType?: string;
}

export function createProgram(): Command {
  const program = new Command();
  program.name("sermon").description("Clean and master AIFF sermon recordings").version("0.1.0");

  program
    .command("plan-metadata")
    .description("Read sermon metadata from a Planning Center Services plan")
    .requiredOption("--date <yyyy-mm-dd>", "service-plan date")
    .option("--service-type <id>", "Planning Center Service Type ID")
    .option("--plan-id <id>", "Planning Center Plan ID; useful when a date is ambiguous")
    .option("--json", "print machine-readable JSON", false)
    .action(async (options: PlanMetadataCommandOptions) => {
      const config = await loadPlanningCenterConfig();
      const serviceTypeId = options.serviceType ?? config.defaultServiceTypeId;
      if (!serviceTypeId) {
        throw new Error("Pass --service-type or configure PLANNING_CENTER_DEFAULT_SERVICE_TYPE_ID");
      }
      const metadata = await readSermonPlanMetadata(new PlanningCenterClient(config), {
        date: options.date,
        planId: options.planId,
        serviceTypeId,
      });
      if (options.json) {
        console.log(JSON.stringify(metadata, null, 2));
        return;
      }
      console.log(`Planning Center Plan: ${metadata.planId}`);
      if (metadata.planUrl) console.log(`Plan URL: ${metadata.planUrl}`);
      console.log(`Date: ${metadata.date}`);
      console.log(`Preacher: ${metadata.preacher ?? "(not found)"}`);
      console.log(`Series: ${metadata.sermonSeries ?? "(not found)"}`);
      console.log(`Scripture: ${metadata.scripture ?? "(not found)"}`);
      console.log(`Title: ${metadata.title ?? "(not found)"}`);
      console.log(`Artwork: ${metadata.artwork?.url ?? "(not found)"}`);
      for (const warning of metadata.warnings) console.warn(`Warning: ${warning}`);
    });

  program
    .command("process")
    .description("Process one AIFF sermon recording")
    .argument("<input>", "AIFF source file")
    .requiredOption("--preacher <name>", "preacher/artist name")
    .requiredOption("--series <name>", "sermon series/album")
    .requiredOption("--date <yyyy-mm-dd>", "sermon date")
    .requiredOption("--scripture <reference>", "main preaching text")
    .requiredOption("--artwork <path>", "JPEG or PNG album artwork")
    .option("--title <title>", "MP3 title; defaults to the scripture reference")
    .option("-o, --output <path>", "output MP3 path; overrides output configuration")
    .option("--overwrite", "replace an existing output", false)
    .option("--keep-work-files", "retain intermediate WAV files", false)
    .action(async (input: string, options: ProcessCommandOptions) => {
      const config = await loadSermonConfig();
      const metadata = sermonMetadataSchema.parse({
        organization: config.organization,
        preacher: options.preacher,
        sermonSeries: options.series,
        date: options.date,
        scripture: options.scripture,
        title: options.title,
      });
      const output = options.output ?? buildConfiguredOutputPath(config, metadata);
      const request = processRequestSchema.parse({
        artwork: options.artwork,
        input,
        output,
        metadata,
        overwrite: options.overwrite,
        keepWorkFiles: options.keepWorkFiles,
      });
      const result = await processSermon(request);
      console.log(`Created ${result.outputPath}`);
      console.log(`QC report: ${result.qcReportPath}`);
      if (result.workDirectory !== undefined) {
        console.log(`Work files: ${result.workDirectory}`);
      }
    });

  return program;
}

export async function runCli(arguments_ = process.argv): Promise<void> {
  await createProgram().parseAsync(arguments_);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sermon: ${message}`);
    process.exitCode = 1;
  });
}
