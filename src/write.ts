// File writing helpers (parent directories are created automatically).

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

export async function writeText(p: string, text: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, text);
}

export async function writeBytes(p: string, data: Uint8Array): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data);
}
