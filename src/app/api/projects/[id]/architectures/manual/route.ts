import { db } from "@/db";
import { architectures, projects, requirements } from "@/db/schema";
import { getCloudMapping } from "@/lib/cloud-mapping";
import { runLldRulesEngine } from "@/lib/lld-rules";
import { validateArchitectureLayout } from "@/lib/validation";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

// Helper to compute cost for a component mapping list
function calculateTotalCost(components: any[], provider: "aws" | "azure" | "gcp") {
  let min = 0;
  let max = 0;
  components.forEach((c) => {
    const mapping = c.cloudMappings?.[provider];
    if (mapping?.costEstimate) {
      min += mapping.costEstimate.min || 0;
      max += mapping.costEstimate.max || 0;
    }
  });
  return { min, max };
}

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
    const diff = {
      added: [] as any[],
      removed: [] as any[],
      modified: [] as any[],
      costDelta: {
        aws: { min: 0, max: 0 },
        azure: { min: 0, max: 0 },
        gcp: { min: 0, max: 0 },
      },
    };

    const prevComponents = latestArch ? (latestArch.hld as any).components || [] : [];
    const prevAwsTotal = latestArch ? calculateTotalCost(prevComponents, "aws") : { min: 0, max: 0 };
    const prevAzureTotal = latestArch ? calculateTotalCost(prevComponents, "azure") : { min: 0, max: 0 };
    const prevGcpTotal = latestArch ? calculateTotalCost(prevComponents, "gcp") : { min: 0, max: 0 };

    diff.costDelta.aws = { min: awsCosts.min - prevAwsTotal.min, max: awsCosts.max - prevAwsTotal.max };
    const newAzureTotal = calculateTotalCost(compiledComponents, "azure");
    diff.costDelta.azure = { min: newAzureTotal.min - prevAzureTotal.min, max: newAzureTotal.max - prevAzureTotal.max };
    const newGcpTotal = calculateTotalCost(compiledComponents, "gcp");
    diff.costDelta.gcp = { min: newGcpTotal.min - prevGcpTotal.min, max: newGcpTotal.max - prevGcpTotal.max };

    // Find Added & Modified
    compiledComponents.forEach((newC: any) => {
      const prevC = prevComponents.find((p: any) => p.id === newC.id);
      if (!prevC) {
        diff.added.push({
          id: newC.id,
          name: newC.name,
          type: newC.type,
          reasoning: newC.reasoning || "Manually added by user.",
        });
      } else {
        const changes: any[] = [];
        if (newC.name !== prevC.name) {
          changes.push({
            parameter: "Name",
            oldVal: prevC.name,
            newVal: newC.name,
            reasoning: "Component renamed by user.",
          });
        }

        (["aws", "azure", "gcp"] as const).forEach((prov) => {
          const prevMapping = prevC.cloudMappings?.[prov];
          const newMapping = newC.cloudMappings?.[prov];

          // Service swap: the bound cloud service itself changed for this provider.
          if (prevMapping && newMapping && prevMapping.serviceName !== newMapping.serviceName) {
            changes.push({
              parameter: `${prov.toUpperCase()} Service`,
              oldVal: prevMapping.serviceName,
              newVal: newMapping.serviceName,
              reasoning: newMapping.swapReasoning || "Manually changed by user.",
            });
          }

          const prevLld = prevMapping?.lld?.config || {};
          const newLld = newMapping?.lld?.config || {};

          Object.keys(newLld).forEach((key) => {
            if (newLld[key] !== prevLld[key]) {
              const oldVal = prevLld[key] || "none";
              const newVal = newLld[key];
              const paramReason =
                newMapping?.lld?.reasoning?.[key] ||
                "Manually updated by user.";
              changes.push({
                parameter: `${prov.toUpperCase()} ${key}`,
                oldVal,
                newVal,
                reasoning: paramReason,
              });
            }
          });

          // Config keys that existed under the previous service but no longer apply
          // (e.g. serverless "memory"/"timeout" keys disappearing after swapping to a
          // container-based service, which uses "instanceSize"/"minInstances" instead).
          Object.keys(prevLld).forEach((key) => {
            if (!(key in newLld)) {
              changes.push({
                parameter: `${prov.toUpperCase()} ${key}`,
                oldVal: prevLld[key],
                newVal: "removed",
                reasoning: "No longer applicable after the service change.",
              });
            }
          });
        });

        if (changes.length > 0) {
          diff.modified.push({
            id: newC.id,
            name: newC.name,
            type: newC.type,
            changes,
          });
        }
      }
    });

    // Find Removed
    prevComponents.forEach((prevC: any) => {
      const newC = compiledComponents.find((n: any) => n.id === prevC.id);
      if (!newC) {
        diff.removed.push({
          id: prevC.id,
          name: prevC.name,
          type: prevC.type,
        });
      }
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
