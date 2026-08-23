import { execa, type ResultPromise } from "execa";

export interface CommandResult {
  stderr: string;
  stdout: string;
}

export interface CommandRunner {
  run(command: string, arguments_: readonly string[]): Promise<CommandResult>;
}

export class ExecaCommandRunner implements CommandRunner {
  async run(command: string, arguments_: readonly string[]): Promise<CommandResult> {
    const process: ResultPromise = execa(command, arguments_, {
      encoding: "utf8",
      reject: true,
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await process;
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  }
}
