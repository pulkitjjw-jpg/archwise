import { db } from "@/db";
import { architectures, projects } from "@/db/schema";
import { generateTerraformCode } from "@/lib/terraform-generator";
import { desc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const providerParam = url.searchParams.get("provider") || "aws";

    if (providerParam !== "aws" && providerParam !== "azure" && providerParam !== "gcp") {
      return NextResponse.json({ error: "Invalid provider specified" }, { status: 400 });
    }

    // 1. Fetch project details
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // 2. Fetch the latest generated architecture
    const [record] = await db
      .select()
      .from(architectures)
      .where(eq(architectures.projectId, id))
      .orderBy(desc(architectures.createdAt))
      .limit(1);

    if (!record) {
      return NextResponse.json({ error: "No architecture design found. Please generate one first." }, { status: 404 });
    }

    // 3. Generate Terraform files map
    const filesMap = generateTerraformCode(
      providerParam,
      project.name,
      record.hld.components,
      record.hld.connections
    );

    // 4. Create ZIP archive using JSZip
    const zip = new JSZip();
    Object.keys(filesMap).forEach((filename) => {
      zip.file(filename, filesMap[filename]);
    });

    // Generate zip content as a Node.js Buffer
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9]/g, "-");

    // 5. Stream back the ZIP file
    return new Response(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}-terraform-${providerParam}.zip"`,
      },
    });
  } catch (error: any) {
    console.error("Error exporting Terraform files:", error);
    return NextResponse.json({ error: error.message || "Failed to export Terraform files" }, { status: 500 });
  }
}
