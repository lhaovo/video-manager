import { z } from "zod";

export const librarySchema = z.enum(["unprocessed", "processing", "archived", "processed"]);
export const statusSchema = z.enum(["unprocessed", "processing", "archived", "processed"]);
export const userVideoLibrarySchema = z.enum(["unprocessed", "processed"]);
export const userVideoStatusSchema = z.enum(["unprocessed", "archived", "processed"]);

export function parseId(value: unknown) {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid id");
  }
  return parsed.data;
}
