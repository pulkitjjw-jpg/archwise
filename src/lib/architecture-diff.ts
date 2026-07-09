// Deterministic diff/cost computation shared by every architecture-save path (LLM auto-generate,
// growth-trigger regenerate, and manual edit). Computing this in TypeScript — rather than asking
// the LLM to compute it — guarantees costDelta is always present and that before/after values are
// always read from the actual stored previous/new component records, never hallucinated.

export type CostBand = { min: number; max: number };

export function calculateTotalCost(components: any[], provider: "aws" | "azure" | "gcp"): CostBand {
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

export type ArchitectureDiff = {
  added: Array<{ id: string; name: string; type: string; reasoning: string }>;
  removed: Array<{ id: string; name: string; type: string }>;
  modified: Array<{
    id: string;
    name: string;
    type: string;
    changes: Array<{ parameter: string; oldVal: string; newVal: string; reasoning: string }>;
  }>;
  costDelta: { aws: CostBand; azure: CostBand; gcp: CostBand };
};

export function computeArchitectureDiff(
  newComponents: any[],
  prevComponents: any[],
  options?: { defaultAddedReasoning?: string; defaultChangeReasoning?: string }
): ArchitectureDiff {
  const defaultAddedReasoning = options?.defaultAddedReasoning || "Newly added component.";
  const defaultChangeReasoning = options?.defaultChangeReasoning || "Updated.";

  const diff: ArchitectureDiff = {
    added: [],
    removed: [],
    modified: [],
    costDelta: {
      aws: { min: 0, max: 0 },
      azure: { min: 0, max: 0 },
      gcp: { min: 0, max: 0 },
    },
  };

  (["aws", "azure", "gcp"] as const).forEach((prov) => {
    const newTotal = calculateTotalCost(newComponents, prov);
    const prevTotal = calculateTotalCost(prevComponents, prov);
    diff.costDelta[prov] = { min: newTotal.min - prevTotal.min, max: newTotal.max - prevTotal.max };
  });

  newComponents.forEach((newC: any) => {
    const prevC = prevComponents.find((p: any) => p.id === newC.id);
    if (!prevC) {
      diff.added.push({
        id: newC.id,
        name: newC.name,
        type: newC.type,
        reasoning: newC.reasoning || defaultAddedReasoning,
      });
      return;
    }

    const changes: ArchitectureDiff["modified"][number]["changes"] = [];
    if (newC.name !== prevC.name) {
      changes.push({
        parameter: "Name",
        oldVal: prevC.name,
        newVal: newC.name,
        reasoning: "Component renamed.",
      });
    }

    (["aws", "azure", "gcp"] as const).forEach((prov) => {
      const prevMapping = prevC.cloudMappings?.[prov];
      const newMapping = newC.cloudMappings?.[prov];
      if (!prevMapping || !newMapping) return;

      // Service swap: the bound cloud service itself changed for this provider.
      if (prevMapping.serviceName !== newMapping.serviceName) {
        changes.push({
          parameter: `${prov.toUpperCase()} Service`,
          oldVal: prevMapping.serviceName,
          newVal: newMapping.serviceName,
          reasoning: newMapping.swapReasoning || defaultChangeReasoning,
        });
      }

      const prevCost = prevMapping.costEstimate;
      const newCost = newMapping.costEstimate;
      if (prevCost && newCost && (prevCost.min !== newCost.min || prevCost.max !== newCost.max)) {
        changes.push({
          parameter: `${prov.toUpperCase()} Cost Estimate`,
          oldVal: `$${prevCost.min} - $${prevCost.max}/mo`,
          newVal: `$${newCost.min} - $${newCost.max}/mo`,
          reasoning: "Cost estimate updated based on the revised requirements.",
        });
      }

      const prevLld = prevMapping.lld?.config || {};
      const newLld = newMapping.lld?.config || {};

      Object.keys(newLld).forEach((key) => {
        if (newLld[key] !== prevLld[key]) {
          changes.push({
            parameter: `${prov.toUpperCase()} ${key}`,
            oldVal: prevLld[key] !== undefined ? prevLld[key] : "none",
            newVal: newLld[key],
            reasoning: newMapping.lld?.reasoning?.[key] || defaultChangeReasoning,
          });
        }
      });

      // Config keys that existed under the previous service but no longer apply (e.g. serverless
      // "memory"/"timeout" keys disappearing after swapping to a container-based service, which
      // uses "instanceSize"/"minInstances" instead).
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
      diff.modified.push({ id: newC.id, name: newC.name, type: newC.type, changes });
    }
  });

  prevComponents.forEach((prevC: any) => {
    const newC = newComponents.find((n: any) => n.id === prevC.id);
    if (!newC) {
      diff.removed.push({ id: prevC.id, name: prevC.name, type: prevC.type });
    }
  });

  return diff;
}
