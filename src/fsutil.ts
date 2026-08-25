import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write a file via a temp name and atomic rename so readers never observe a
 * torn write and a crash cannot leave a truncated state file behind. The temp
 * name carries a random suffix so concurrent writers (same process or sibling
 * processes) never share one temp path and race each other's rename to ENOENT.
 */
export async function atomicWriteFile(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}
