export interface ValidationError {
  type: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateArchitectureLayout(
  components: any[],
  connections: any[],
  requirements?: {
    functional: string[];
    nonFunctional: {
      expectedScale: string;
      readWritePattern: string;
      dataNature: string;
      latencySensitivity: string;
      budget: string;
      teamMaturity: string;
      compliance: string;
    };
  },
  activeProviderCosts?: { min: number; max: number }
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Orphaned Components Check (Hard Error)
  if (components.length > 1) {
    components.forEach((c) => {
      const isConnected = connections.some(
        (conn) => conn.from === c.id || conn.to === c.id
      );
      if (!isConnected) {
        errors.push(`"${c.name}" is orphaned. Every component must be connected to at least one other component.`);
      }
    });
  }

  // 2. Broken DB Dependency Check (Hard Error)
  const hasCompute = components.some((c) => c.type === "compute");
  const hasDatabase = components.some(
    (c) => c.type === "db" || c.type === "database" || c.type === "storage"
  );
  if (hasCompute && !hasDatabase) {
    errors.push("Broken dependency: Compute components are present, but there is no Database or Object Storage component configured in the layout.");
  }

  // 3. Bypass Checks (Soft Warnings)
  connections.forEach((conn) => {
    const fromComponent = components.find((c) => c.id === conn.from);
    const toComponent = components.find((c) => c.id === conn.to);

    if (fromComponent && toComponent) {
      // CDN directly to Database
      if (
        fromComponent.type === "cdn" &&
        (toComponent.type === "db" || toComponent.type === "database")
      ) {
        warnings.push(
          `Unusual pattern: CDN "${fromComponent.name}" connects directly to Database "${toComponent.name}" without an intermediate compute or caching layer.`
        );
      }

      // Load Balancer directly to Database
      if (
        fromComponent.type === "lb" &&
        (toComponent.type === "db" || toComponent.type === "database")
      ) {
        warnings.push(
          `Unusual pattern: Load Balancer "${fromComponent.name}" connects directly to Database "${toComponent.name}" without an intermediate compute or caching layer.`
        );
      }
    }
  });

  // 4. Budget Overrun Check (Soft Warning)
  if (requirements?.nonFunctional?.budget && activeProviderCosts) {
    const budgetStr = requirements.nonFunctional.budget.toLowerCase();
    const isLowBudget =
      budgetStr.includes("low") ||
      budgetStr.includes("tight") ||
      budgetStr.includes("50") ||
      budgetStr.includes("30") ||
      budgetStr.includes("100") ||
      budgetStr.includes("$100");

    if (isLowBudget && activeProviderCosts.min > 120) {
      warnings.push(
        `Unusual budget alignment: the updated architecture's estimated cost ($${activeProviderCosts.min} - $${activeProviderCosts.max}/mo) exceeds your stated budget threshold.`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}
