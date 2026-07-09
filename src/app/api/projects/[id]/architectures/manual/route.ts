import { db } from "@/db";
import { architectures, projects, requirements } from "@/db/schema";
import { getCloudMapping } from "@/lib/cloud-mapping";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { validateArchitectureLayout } from "@/lib/validation";
import { calculateTotalCost, computeArchitectureDiff } from "@/lib/architecture-diff";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { components, connections } = await request.json();

    if (!components || !connections) {
      return NextResponse.json(
        { error: "components and connections are required" },
        { status: 400 }
      );
    }

    // 1. Fetch project details
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // 2. Fetch latest requirements
    const [reqs] = await db
      .select()
      .from(requirements)
      .where(eq(requirements.projectId, id))
      .orderBy(desc(requirements.version))
      .limit(1);

    if (!reqs) {
      return NextResponse.json(
        { error: "Requirements must exist before saving manual architecture modifications" },
        { status: 400 }
      );
    }

    const reqsContext = {
      functional: reqs.functional as string[],
      nonFunctional: reqs.nonFunctional as any,
    };
    const industryContext = reqs.industryContext;

    // 3. Compile manual components (resolve missing cloud mappings and LLD baselines)
    const compiledComponents = components.map((c: any) => {
      // Check if mappings already exist
      if (c.cloudMappings) {
        return c;
      }

      // Automatically generate mappings & LLD defaults for a new node. Passing industryContext
      // keeps a manually-added component (e.g. a second database) subject to the same
      // compliance-mandated config (encryption in transit, etc.) as the auto-generated baseline.
      const awsMapping = getCloudMapping("aws", c.type, c.id, reqsContext);
      const azureMapping = getCloudMapping("azure", c.type, c.id, reqsContext);
      const gcpMapping = getCloudMapping("gcp", c.type, c.id, reqsContext);
      const k8sMapping = getCloudMapping("kubernetes", c.type, c.id, reqsContext);
      const privateMapping = getCloudMapping("private", c.type, c.id, reqsContext);

      const awsLld = runLldRulesEngine("aws", c.type, c.id, reqsContext, undefined, industryContext);
      const azureLld = runLldRulesEngine("azure", c.type, c.id, reqsContext, undefined, industryContext);
      const gcpLld = runLldRulesEngine("gcp", c.type, c.id, reqsContext, undefined, industryContext);
      const k8sLld = runLldRulesEngine("kubernetes", c.type, c.id, reqsContext, undefined, industryContext);
      const privateLld = runLldRulesEngine("private", c.type, c.id, reqsContext, undefined, industryContext);

      return {
        ...c,
        reasoning: c.reasoning || "Manually added by user.",
        metadata: {
          ...c.metadata,
          isManuallyAdded: true,
          overrideSource: "user",
        },
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
          kubernetes: {
            serviceName: k8sMapping.serviceName,
            alternatives: k8sMapping.alternatives,
            costEstimate: k8sMapping.costEstimate,
            lld: {
              config: k8sLld.config,
              reasoning: k8sLld.reasoning,
            },
          },
          private: {
            serviceName: privateMapping.serviceName,
            alternatives: privateMapping.alternatives,
            costEstimate: privateMapping.costEstimate,
            lld: {
              config: privateLld.config,
              reasoning: privateLld.reasoning,
            },
          },
        },
      };
    });

    // 4. Run Layout Validation
    const awsCosts = calculateTotalCost(compiledComponents, "aws");
    const validation = validateArchitectureLayout(
      compiledComponents,
      connections,
      reqsContext,
      awsCosts
    );

    if (!validation.isValid) {
      return NextResponse.json(
        { error: `Validation blocked save: ${validation.errors.join("; ")}` },
        { status: 400 }
      );
    }

    // 5. Fetch previous version to compute diff and calculate next version
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

    // 6. Compute diff against previous architecture version
    const prevComponents = latestArch ? (latestArch.hld as any).components || [] : [];
    const diff = computeArchitectureDiff(compiledComponents, prevComponents, {
      defaultAddedReasoning: "Manually added by user.",
      defaultChangeReasoning: "Manually changed by user.",
    });

    // 7. Save manual architecture version
    const [record] = await db
      .insert(architectures)
      .values({
        projectId: id,
        version: nextVersion,
        hld: {
          components: compiledComponents,
          connections,
        } as any,
        reasoning: {
          decisions: [
            {
              component: "system",
              choice: "manual_override",
              rationale: "Layout manually adjusted by project maintainer.",
              tradeoffs: [],
              alternatives: [],
            },
          ],
          assumptions: latestArch ? (latestArch.reasoning as any).assumptions || [] : [],
          risks: latestArch ? (latestArch.reasoning as any).risks || [] : [],
          recommendation: latestArch ? (latestArch.reasoning as any).recommendation : undefined,
          diff, // Cache delta diff logs
        } as any,
        cloudProvider: latestArch?.cloudProvider || "aws",
      })
      .returning();

    // 8. Update project's current version
    await db
      .update(projects)
      .set({ currentVersion: nextVersion })
      .where(eq(projects.id, id));

    return NextResponse.json({ architecture: record }, { status: 201 });
  } catch (error: any) {
    console.error("Error saving manual architecture override:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save manual changes" },
      { status: 500 }
    );
  }
}
