#!/usr/bin/env node
import { basename, dirname, extname, join } from "node:path";
import { Command } from "commander";
import { processRequestSchema } from "./config/schema.js";
import { processSermon } from "./process/process-sermon.js";

interface ProcessCommandOptions {
  date: string;
  keepWorkFiles: boolean;
  output?: string;
  overwrite: boolean;
  preacher: string;
  scripture: string;
  series: string;
  title?: string;
}

function defaultOutput(input: string): string {
  const extension = extname(input);
  return join(dirname(input), `${basename(input, extension)}.mp3`);
}

const program = new Command();
program.name("sermon").description("Clean and master AIFF sermon recordings").version("0.1.0");

program
  .command("process")
  .description("Process one AIFF sermon recording")
  .argument("<input>", "AIFF source file")
  .requiredOption("--preacher <name>", "preacher/artist name")
  .requiredOption("--series <name>", "sermon series/album")
  .requiredOption("--date <yyyy-mm-dd>", "sermon date")
  .requiredOption("--scripture <reference>", "main preaching text")
  .option("--title <title>", "MP3 title; defaults to the scripture reference")
  .option("-o, --output <path>", "output MP3 path")
  .option("--overwrite", "replace an existing output", false)
  .option("--keep-work-files", "retain intermediate WAV files", false)
  .action(async (input: string, options: ProcessCommandOptions) => {
    const request = processRequestSchema.parse({
      input,
      output: options.output ?? defaultOutput(input),
      metadata: {
        preacher: options.preacher,
        sermonSeries: options.series,
        date: options.date,
        scripture: options.scripture,
        title: options.title,
      },
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

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sermon: ${message}`);
  process.exitCode = 1;
});
