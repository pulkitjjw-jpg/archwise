import { db } from "@/db";
import { architectures, projects, requirements } from "@/db/schema";
import { generateTerraformCode } from "@/lib/terraform-generator";
import { generateKubernetesManifests } from "@/lib/k8s-manifest-generator";
import { desc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { NextResponse } from "next/server";

const VALID_PROVIDERS = ["aws", "azure", "gcp", "kubernetes", "private"];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const providerParam = url.searchParams.get("provider") || "aws";

    if (!VALID_PROVIDERS.includes(providerParam)) {
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

    // 3. Fetch the latest requirements to know if industry-specific compliance framing
    // (PCI-DSS / HIPAA) belongs in the generated README.
    const [reqs] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    // 4. Generate the export file set — Kubernetes gets manifests instead of Terraform,
    // everything else (including "private") gets Terraform.
    const filesMap =
      providerParam === "kubernetes"
        ? generateKubernetesManifests(
            project.name,
            record.hld.components,
            record.hld.connections,
            reqs?.industryContext
          )
        : generateTerraformCode(
            providerParam as "aws" | "azure" | "gcp" | "private",
            project.name,
            record.hld.components,
            record.hld.connections,
            reqs?.industryContext
          );

    // Create ZIP archive using JSZip
    const zip = new JSZip();
    Object.keys(filesMap).forEach((filename) => {
      zip.file(filename, filesMap[filename]);
    });

    // Generate zip content as a Node.js Buffer
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9]/g, "-");
    const exportLabel = providerParam === "kubernetes" ? "k8s-manifests" : "terraform";

    // 5. Stream back the ZIP file
    return new Response(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName}-${exportLabel}-${providerParam}.zip"`,
      },
    });
  } catch (error: any) {
    console.error("Error exporting Terraform files:", error);
    return NextResponse.json({ error: error.message || "Failed to export Terraform files" }, { status: 500 });
  }
}
