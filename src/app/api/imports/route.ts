import { z } from "zod";

import { requireSession } from "@/domain/auth/session";
import { MAX_IMPORT_FILE_BYTES } from "@/domain/imports/import-limits";
import { importKakaoExport } from "@/domain/imports/import-service";
import { parseKakaoExport } from "@/domain/kakao/parser";

const importFormSchema = z.object({
  selfName: z.string().trim().min(1, "selfName is required"),
});

function badRequest(error: z.ZodError): Response {
  return Response.json({ error: "Invalid import request", issues: error.flatten() }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  await requireSession(request);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid import request" }, { status: 400 });
  }

  const form = importFormSchema.safeParse({ selfName: formData.get("selfName") });
  if (!form.success) return badRequest(form.error);

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Invalid import request", issues: { formErrors: ["file is required"] } }, { status: 400 });
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return new Response("Import file is too large", { status: 413 });
  }

  const rawText = await file.text();
  const parsed = parseKakaoExport(rawText);
  const title = parsed.title || file.name.replace(/\.txt$/i, "");
  if (!title) {
    return Response.json({ error: "Invalid import request", issues: { formErrors: ["conversation title is required"] } }, { status: 400 });
  }

  const summary = await importKakaoExport({ title, selfName: form.data.selfName, rawText });
  return Response.json(summary, { status: 201 });
}
