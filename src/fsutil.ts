import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  try {
    await replace(temporary, file);
  } catch (error) {
    // A failed rename leaves the payload behind under the temp name; for a state
    // file that can hold an API key, littering it next to the target is a leak.
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Codes Windows reports when the destination of a replace-rename is momentarily locked. */
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

async function replace(temporary: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(temporary, file);
    } catch (error) {
      // Unlike POSIX, Windows rename cannot displace an open destination: an
      // antivirus scan or a sibling writer holding the file yields a transient
      // permission error rather than a real failure, so back off and retry.
      if (attempt === 4 || !LOCKED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 20));
    }
  }
}
