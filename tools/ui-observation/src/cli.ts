#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  captureScene,
  checkConnection,
  inspectBundle,
  queryBundle,
  exportReference,
  compareBundles,
  createViewer,
  inspectElectron,
} from "./index.js";
import { json } from "./util.js";

const [command, ...args] = process.argv.slice(2);
const read = async (path: string | undefined) => {
  if (!path) throw new Error("Missing JSON file argument");
  return JSON.parse(await readFile(path, "utf8"));
};
const required = (i: number) => {
  if (!args[i]) throw new Error("Missing argument; use --help");
  return args[i]!;
};
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Host signal"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  let result: unknown;
  switch (command) {
    case "inspect-electron":
      result = await inspectElectron(await read(args[0]));
      break;
    case "probe":
      result = await checkConnection(await read(args[0]));
      break;
    case "capture":
      result = await captureScene(await read(args[0]), {
        outputDir: required(1),
        signal: controller.signal,
      });
      break;
    case "inspect":
      result = await inspectBundle(required(0));
      break;
    case "query":
      result = await queryBundle(
        required(0),
        args[1] ? await read(args[1]) : {},
      );
      break;
    case "export":
      result = await exportReference(required(0), {
        ...(await read(args[2])),
        outputDir: required(1),
      });
      break;
    case "compare":
      result = await compareBundles(required(0), required(1));
      break;
    case "viewer":
      result = await createViewer(required(0), required(1), args[2]);
      break;
    case "--help":
    case undefined:
      result = {
        usage: [
          "inspect-electron connection.json",
          "probe scene.json",
          "capture scene.json OUTPUT_DIR",
          "inspect RUN_DIR",
          "query RUN_DIR [query.json]",
          "export RUN_DIR NEW_EXPORT_DIR options.json",
          "compare EXPORT_DIR IMPLEMENTATION_RUN_DIR",
          "viewer RUN_DIR NEW_HTML_FILE [SECOND_RUN_DIR]",
        ],
      };
      break;
    default:
      throw new Error(`Unknown command ${command}`);
  }
  process.stdout.write(json(result));
  const status = result as {
    manifest?: { outcome: string };
    issues?: unknown[];
    shutdown?: unknown[];
    outcome?: string;
  };
  if (
    (status.manifest && status.manifest.outcome !== "completed") ||
    status.issues?.length ||
    status.shutdown?.length ||
    status.outcome === "fail"
  )
    process.exitCode = 2;
} catch (error) {
  process.stderr.write(
    json({ error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
