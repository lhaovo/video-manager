import fs from "node:fs/promises";

type NodeFsError = Error & { code?: string };

function isRetriableFsReadError(error: unknown) {
  const code = (error as NodeFsError).code;
  return code === "ENOENT" || code === "ESTALE" || code === "EIO";
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function statFile(filePath: string) {
  const delays = [80, 200, 500, 1000];

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fs.stat(filePath);
    } catch (error) {
      if (attempt >= delays.length || !isRetriableFsReadError(error)) {
        throw error;
      }
      await wait(delays[attempt]);
    }
  }

  return fs.stat(filePath);
}

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

export async function copyThenRemoveFile(sourcePath: string, targetPath: string) {
  const stat = await statFile(sourcePath);
  await fs.copyFile(sourcePath, targetPath);
  await fs.utimes(targetPath, stat.atime, stat.mtime);
  await fs.rm(sourcePath, { force: true });
}
