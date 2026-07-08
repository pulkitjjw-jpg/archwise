import { db } from "@/db";
import { architectures, projects, requirements } from "@/db/schema";
import { validateAndGenerateArchitecture } from "@/lib/llm";
import { getCloudMapping } from "@/lib/cloud-mapping";
import { runRulesEngine } from "@/lib/rules-engine";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const all = url.searchParams.get("all") === "true";

    if (all) {
      const history = await db
        .select()
        .from(architectures)
        .where(eq(architectures.projectId, id))
        .orderBy(desc(architectures.createdAt));
      return NextResponse.json({ architectures: history });
    }

    // Fetch the latest generated architecture
    const [record] = await db
      .select()
      .from(architectures)
      .where(eq(architectures.projectId, id))
      .orderBy(desc(architectures.createdAt))
      .limit(1);

    if (!record) {
      return NextResponse.json({ error: "Architecture not found" }, { status: 404 });
    }

    return NextResponse.json({ architecture: record });
  } catch (error: any) {
    console.error("Error fetching architecture:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch architecture" }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // 1. Fetch project details
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // 2. Fetch the latest requirements
    const [reqs] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    if (!reqs) {
      return NextResponse.json({ error: "Requirements must be generated before architecture" }, { status: 400 });
    }

    const reqsContext = {
      functional: reqs.functional as string[],
      nonFunctional: reqs.nonFunctional as any,
    };

    // 3. Run rules engine to produce baseline HLD
    const baseline = runRulesEngine(reqsContext);

    // 4. Resolve mappings, costs, and LLD baselines for AWS, Azure, and GCP for each component
    const mappedBaselineComponents = baseline.components.map((c) => {
      const awsMapping = getCloudMapping("aws", c.type, c.id, reqsContext);
      const azureMapping = getCloudMapping("azure", c.type, c.id, reqsContext);
      const gcpMapping = getCloudMapping("gcp", c.type, c.id, reqsContext);

      // Run LLD rules for all three clouds
      const awsLld = runLldRulesEngine("aws", c.type, c.id, reqsContext);
      const azureLld = runLldRulesEngine("azure", c.type, c.id, reqsContext);
      const gcpLld = runLldRulesEngine("gcp", c.type, c.id, reqsContext);

      return {
        ...c,
        cloudMappings: {
          aws: {
            serviceName: awsMapping.serviceName,
            alternatives: awsMapping.alternatives,
            costEstimate: awsMapping.costEstimate,
            lld: {
              config: awsLld.config,
              reasoning: awsLld.reasoning,
            },
          },
          azure: {
            serviceName: azureMapping.serviceName,
            alternatives: azureMapping.alternatives,
            costEstimate: azureMapping.costEstimate,
            lld: {
              config: azureLld.config,
              reasoning: azureLld.reasoning,
            },
          },
          gcp: {
            serviceName: gcpMapping.serviceName,
            alternatives: gcpMapping.alternatives,
            costEstimate: gcpMapping.costEstimate,
            lld: {
              config: gcpLld.config,
              reasoning: gcpLld.reasoning,
            },
          },
        },
      };
    });

    // 5. Calculate baseline total costs
    const providerCosts = {
      aws: { min: 0, max: 0 },
      azure: { min: 0, max: 0 },
      gcp: { min: 0, max: 0 },
    };

    mappedBaselineComponents.forEach((c) => {
      providerCosts.aws.min += c.cloudMappings.aws.costEstimate.min;
      providerCosts.aws.max += c.cloudMappings.aws.costEstimate.max;

      providerCosts.azure.min += c.cloudMappings.azure.costEstimate.min;
      providerCosts.azure.max += c.cloudMappings.azure.costEstimate.max;

      providerCosts.gcp.min += c.cloudMappings.gcp.costEstimate.min;
      providerCosts.gcp.max += c.cloudMappings.gcp.costEstimate.max;
    });

    // 6. Fetch the latest architecture for versioning and delta comparison
    const [latestArch] = await db
      .select()
      .from(architectures)
      .where(eq(architectures.projectId, id))
      .orderBy(desc(architectures.createdAt))
      .limit(1);

    let nextVersion = "0.1.0";
    if (latestArch) {
      const parts = latestArch.version.split(".");
      if (parts.length === 3) {
        const patch = parseInt(parts[2], 10) + 1;
        nextVersion = `${parts[0]}.${parts[1]}.${patch}`;
      }
    }

    // 7. Validate, enrich and recommend provider with LLM, passing HLD + LLD baselines & previous components
    const enriched = await validateAndGenerateArchitecture(
      project.name,
      reqsContext,
      {
        components: mappedBaselineComponents,
        connections: baseline.connections,
      },
      providerCosts,
      latestArch ? (latestArch.hld as any).components : null
    );

    // 8. Save new architecture version with all three cloud mappings, recommendations, and LLD specs
    const [record] = await db
      .insert(architectures)
      .values({
        projectId: id,
        version: nextVersion,
        hld: {
          components: enriched.components,
          connections: enriched.connections,
        } as any,
        reasoning: {
          decisions: baseline.rulesTrace.map((rule) => ({
            component: "system",
            choice: rule,
            rationale: "Matched deterministic rule pattern in system requirements.",
            tradeoffs: [],
            alternatives: [],
          })),
          assumptions: enriched.assumptions,
          risks: enriched.risks,
          recommendation: enriched.recommendation, // Persist recommended provider details
          diff: enriched.diff, // Cache the calculated delta diff
        } as any,
        cloudProvider: "aws", // default display config
      })
      .returning();

    // 9. Update project's current version
    await db
      .update(projects)
      .set({ currentVersion: nextVersion })
      .where(eq(projects.id, id));

    return NextResponse.json({ architecture: record }, { status: 201 });
  } catch (error: any) {
    console.error("Error generating architecture:", error);
    return NextResponse.json({ error: error.message || "Failed to generate architecture" }, { status: 500 });
  }
}
