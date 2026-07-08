import { seedPlanningArtifacts } from "../lib/planning-store";

async function main() {
  console.log("Seeding planning artifacts...");
  try {
    await seedPlanningArtifacts();
    console.log("Seeding completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  }
}

main();
