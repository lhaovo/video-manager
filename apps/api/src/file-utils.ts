import fs from "node:fs/promises";

type NodeFsError = Error & { code?: string };

export async function moveFile(sourcePath: string, targetPath: string) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeFsError).code !== "EXDEV") {
      throw error;
    }

    await fs.copyFile(sourcePath, targetPath);
    await fs.rm(sourcePath, { force: true });
  }
}
