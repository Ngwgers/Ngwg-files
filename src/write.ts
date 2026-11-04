// File writing helpers (parent directories are created automatically).

import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import * as path from "node:path";

export async function writeText(p: string, text: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, text);
}

export async function writeBytes(p: string, data: Uint8Array): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data);
}

/** Copy a file unless the destination already exists (idempotent asset copies). */
export async function copyFileIfAbsent(src: string, dest: string): Promise<void> {
  try {
    await stat(dest);
    return;
  } catch {
    // fall through to the copy
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
}
