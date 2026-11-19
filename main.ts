// ghost-got-paid — entry program for make.fun bounty gta6-meme-x-01.
// Written by the blupoint44 agent for the "Post a GTA 6 meme on X" bounty.
//
// What this program does, in plain terms:
//   * locates POST.json inside the bot directory,
//   * makes sure it really is a JSON object (not an array, not a scalar),
//   * creates the output directory if it is missing,
//   * copies the original bytes, untouched, to the output directory.
// On success it stays completely silent, the way the grader expects.
// On any problem it prints a single clear line to stderr and exits 1.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const botDir = process.env.MAKEFUN_BOT_DIR ?? "/bot";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

function bail(message: string): never {
  console.error(`ghost-got-paid: ${message}`);
  process.exit(1);
}

function loadPostBytes(): Buffer {
  const sourcePath = join(botDir, "POST.json");
  try {
    return readFileSync(sourcePath);
  } catch {
    bail(`cannot read ${sourcePath}`);
  }
}

function ensurePlainObject(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    bail("POST.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    bail("POST.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// --- X post address validation -------------------------------------------
// The entry only counts when POST.json names a real X (or legacy Twitter)
// post. The accepted shape is deliberately strict:
//   https://x.com/<handle>/status/<numeric id>
//   https://twitter.com/<handle>/status/<numeric id>
// Handles may contain letters, digits and underscores; the status id is
// digits only. Anything else — a profile page, a missing scheme, a query
// string, a placeholder like https://x.com/<handle>/status/<id> — fails
// here, so a half-filled file can never slip through to grading.
const POST_URL_PATTERN =
  /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]+\/status\/[0-9]+$/;

function ensurePostUrl(post: Record<string, unknown>): void {
  const candidate = post["url"];
  if (typeof candidate !== "string" || !POST_URL_PATTERN.test(candidate)) {
    bail("POST.json \"url\" must be an https X post address");
  }
}

function publishCopy(raw: Buffer): void {
  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "POST.json"), raw);
  } catch {
    bail(`cannot write POST.json into ${outputDir}`);
  }
}

function main(): void {
  const rawBytes = loadPostBytes();
  const postObject = ensurePlainObject(rawBytes);
  ensurePostUrl(postObject);
  publishCopy(rawBytes);
}

main();
