// Command line for the training export: `node src/training/cli.ts status|export [--lane a,b] [--private] [--out FILE]`.
// It reads the database directly and sends nothing anywhere. JUHANDU_DATA picks the data folder, as for the server.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store/store.ts";
import { MIN_HUMAN_TEST, MIN_HUMAN_TRAIN, buildTrainingExport, parseLanes, toJsonl } from "./export.ts";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function main(args: string[]): number {
  const command = args[0];
  if (command !== "status" && command !== "export") {
    process.stderr.write("Usage: node src/training/cli.ts status|export [--lane same_story,pipe_ask,wants] [--private] [--out FILE]\n");
    return 2;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const store = new Store(join(process.env["JUHANDU_DATA"] ?? join(root, "data"), "juhandu.sqlite"));
  try {
    const built = buildTrainingExport(store, { lanes: parseLanes(flag(args, "--lane")), includePrivate: args.includes("--private") });
    if (command === "status") {
      process.stdout.write(JSON.stringify({ lanes: built.summaries, minHumanTrain: MIN_HUMAN_TRAIN, minHumanTest: MIN_HUMAN_TEST, logged: store.laneCounts() }, null, 2) + "\n");
      return 0;
    }
    const out = flag(args, "--out");
    if (out) {
      writeFileSync(out, toJsonl(built.rows), "utf8");
      process.stdout.write(JSON.stringify({ file: out, rows: built.rows.length, lanes: built.summaries }, null, 2) + "\n");
    } else process.stdout.write(toJsonl(built.rows));
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

process.exitCode = main(process.argv.slice(2));
