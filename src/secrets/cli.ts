// Command line for the SecretStore: node src/secrets/cli.ts status | has <name> | set <name> | delete <name>
// "set" reads the value from standard input (so it never appears in the shell history or the process list). Nothing here ever prints a value.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSecretStore } from "./backends.ts";
import { assertSecretName } from "./store.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const dataDir = process.env["JUHANDU_DATA"] ?? join(root, "data");
const { store, notes } = buildSecretStore(process.env, dataDir);
for (const note of notes) console.warn(note);

const [command, name] = process.argv.slice(2);
try {
  if (command === "status") {
    for (const b of await store.status()) console.log(`${b.id}: ${b.available ? "available" : "not available"}${b.writable ? "" : ", read only"}`);
  } else if (command === "has" && name) {
    assertSecretName(name);
    console.log((await store.has(name)) ? "stored" : "not stored");
  } else if (command === "set" && name) {
    assertSecretName(name);
    if (process.stdin.isTTY) {
      console.error("Pipe the value in on standard input, for example: type key.txt | node src/secrets/cli.ts set cogitator/interactive");
      process.exit(2);
    }
    const where = await store.set(name, await readStdin());
    console.log(`stored in ${where}`);
  } else if (command === "delete" && name) {
    assertSecretName(name);
    await store.delete(name);
    console.log("deleted");
  } else {
    console.error("Usage: node src/secrets/cli.ts status | has <name> | set <name> | delete <name>");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
