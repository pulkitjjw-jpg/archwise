import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export type PlanningArtifactContent = {
  sections: Array<{
    heading: string;
    body: string;
    bullets?: string[];
  }>;
  tables?: Array<{
    title: string;
    columns: string[];
    rows: string[][];
  }>;
  tasks?: Array<{
    phase: string;
    items: string[];
  }>;
};

export const planningArtifacts = pgTable("planning_artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  priority: text("priority").notNull(),
  summary: text("summary").notNull(),
  content: jsonb("content").$type<PlanningArtifactContent>().notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Phase 1 Schema Tables

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  owner: text("owner"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  currentVersion: text("current_version").notNull().default("0.1.0"),
});

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  role: text("role").notNull(), // 'user' | 'assistant'
  message: text("message").notNull(),
  stage: text("stage").notNull(), // 'intake' | 'brainstorm' | 'refinement'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RequirementContent = {
  [key: string]: any;
};

export const requirements = pgTable("requirements", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  functional: jsonb("functional").$type<RequirementContent>().notNull().default({}),
  nonFunctional: jsonb("non_functional").$type<RequirementContent>().notNull().default({}),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type HldContent = {
  components: Array<{
    id: string;
    name: string;
    type: string; // e.g. web, api, db, queue, cache
    service: string; // bound service name, e.g. AWS Lambda
    description: string;
    reasoning: string; // Component-level explanation trace
    metadata?: Record<string, any>;
    cloudMappings?: {
      aws: {
        serviceName: string;
        alternatives: Array<{ serviceName: string; reason: string }>;
        costEstimate: { min: number; max: number; assumptions: string };
        lld?: {
          config: Record<string, string>;
          reasoning: Record<string, string>;
        };
      };
      azure: {
        serviceName: string;
        alternatives: Array<{ serviceName: string; reason: string }>;
        costEstimate: { min: number; max: number; assumptions: string };
        lld?: {
          config: Record<string, string>;
          reasoning: Record<string, string>;
        };
      };
      gcp: {
        serviceName: string;
        alternatives: Array<{ serviceName: string; reason: string }>;
        costEstimate: { min: number; max: number; assumptions: string };
        lld?: {
          config: Record<string, string>;
          reasoning: Record<string, string>;
        };
      };
    };
  }>;
  connections: Array<{
    from: string;
    to: string;
    protocol?: string;
  }>;
};

export type ReasoningContent = {
  decisions: Array<{
    component: string;
    choice: string;
    rationale: string;
    tradeoffs: string[];
    alternatives: string[];
  }>;
  assumptions: string[];
  risks: string[];
  recommendation?: {
    recommendedProvider: "aws" | "azure" | "gcp";
    rationale: string;
    keyTradeoffs: string[];
  };
  diff?: {
    added: Array<{ id: string; name: string; type: string; reasoning: string }>;
    removed: Array<{ id: string; name: string; type: string }>;
    modified: Array<{
      id: string;
      name: string;
      type: string;
      changes: Array<{ parameter: string; oldVal: string; newVal: string; reasoning: string }>;
    }>;
    costDelta: {
      aws: { min: number; max: number };
      azure: { min: number; max: number };
      gcp: { min: number; max: number };
    };
  };
};

export const architectures = pgTable("architectures", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  version: text("version").notNull(),
  hld: jsonb("hld").$type<HldContent>().notNull(),
  reasoning: jsonb("reasoning").$type<ReasoningContent>().notNull(),
  cloudProvider: text("cloud_provider").notNull().default("aws"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

