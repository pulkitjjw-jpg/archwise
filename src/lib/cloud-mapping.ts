export type CloudMapping = {
  serviceName: string;
  alternatives: Array<{
    serviceName: string;
    reason: string;
    costEstimate: {
      min: number;
      max: number;
      assumptions: string;
    };
  }>;
  costEstimate: {
    min: number;
    max: number;
    assumptions: string;
  };
  swapReasoning?: string;
};

export function getCloudMapping(
  provider: string,
  componentType: string,
  componentId: string,
  requirements: {
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
  }
): CloudMapping {
  const nfr = requirements.nonFunctional;
  const scaleLower = nfr.expectedScale.toLowerCase();
  const budgetLower = nfr.budget.toLowerCase();
  const teamLower = nfr.teamMaturity.toLowerCase();

  const isHighScale =
    scaleLower.includes("high") ||
    scaleLower.includes("million") ||
    scaleLower.includes("100,000") ||
    scaleLower.includes("10k") ||
    scaleLower.includes("50k");

  const isLowBudget =
    budgetLower.includes("low") ||
    budgetLower.includes("50") ||
    budgetLower.includes("30") ||
    budgetLower.includes("tight");

  if (provider === "aws") {
    switch (componentType) {
      case "cdn":
        return {
          serviceName: "Amazon CloudFront",
          alternatives: [
            {
              serviceName: "AWS Global Accelerator",
              reason: "Chose CloudFront because it supports edge caching for static assets, whereas Global Accelerator is better suited for raw TCP/UDP latency optimizations.",
              costEstimate: {
                min: isHighScale ? 30 : 18,
                max: isHighScale ? 200 : 40,
                assumptions: "AWS Global Accelerator fixed hourly accelerator fee (~$18/mo) plus per-GB data processing charges.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 20 : 0,
            max: isHighScale ? 150 : 5,
            assumptions: isHighScale
              ? "CloudFront data transfer out costs for high volume traffic."
              : "CloudFront free tier covers up to 1TB of data transfer out.",
          },
        };

      case "compute":
        if (componentId === "worker") {
          if (isLowBudget) {
            return {
              serviceName: "AWS Lambda (Worker)",
              alternatives: [
                {
                  serviceName: "Amazon ECS Fargate (Worker Task)",
                  reason: "Chose Lambda because the team has low operational maturity and the budget is tight. Fargate tasks incur higher baseline costs for idle time.",
                  costEstimate: {
                    min: 15,
                    max: isHighScale ? 120 : 30,
                    assumptions: "0.25 vCPU + 0.5 GB RAM container task running continuously for background jobs.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 30 : 5,
                assumptions: "Lambda execution duration costs based on spiky background processing volume.",
              },
            };
          } else {
            return {
              serviceName: "Amazon ECS Fargate (Worker)",
              alternatives: [
                {
                  serviceName: "Amazon EC2 Worker Instance",
                  reason: "Chose Fargate to eliminate instance patching and OS management overhead. EC2 would be cheaper but requires more operations effort.",
                  costEstimate: {
                    min: 7,
                    max: isHighScale ? 60 : 15,
                    assumptions: "Amazon EC2 t3.micro/small instance running continuously, cheaper than Fargate but requires manual patching and scaling.",
                  },
                },
              ],
              costEstimate: {
                min: 15,
                max: isHighScale ? 120 : 30,
                assumptions: "0.25 vCPU + 0.5 GB RAM container task running continuously for background jobs.",
              },
            };
          }
        }

        // Primary Compute
        const isServerlessRules =
          isLowBudget &&
          (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");
        if (isServerlessRules) {
          return {
            serviceName: "AWS Lambda + API Gateway",
            alternatives: [
              {
                serviceName: "Amazon ECS Fargate",
                reason: "Chose Lambda to leverage pay-per-request pricing and zero management overhead. Fargate containers have a higher fixed monthly cost.",
                costEstimate: {
                  min: 25,
                  max: isHighScale ? 250 : 60,
                  assumptions: "Application Load Balancer baseline cost ($18/month) + 1-2 ECS Fargate tasks (0.5 vCPU, 1GB RAM) running 24/7.",
                },
              },
            ],
            costEstimate: {
              min: 0,
              max: isHighScale ? 80 : 10,
              assumptions: "API Gateway HTTP API requests ($1.00/million) + Lambda execution times (128MB RAM, 100ms duration).",
            },
          };
        } else {
          return {
            serviceName: "Amazon ECS Fargate + ALB",
            alternatives: [
              {
                serviceName: "AWS Lambda + API Gateway",
                reason: "Chose Fargate because the application has long-running connections or consistent request streams. ALB provides better caching and SSL termination.",
                costEstimate: {
                  min: 0,
                  max: isHighScale ? 80 : 10,
                  assumptions: "API Gateway HTTP API requests ($1.00/million) + Lambda execution times (128MB RAM, 100ms duration).",
                },
              },
            ],
            costEstimate: {
              min: 25,
              max: isHighScale ? 250 : 60,
              assumptions: "Application Load Balancer baseline cost ($18/month) + 1-2 ECS Fargate tasks (0.5 vCPU, 1GB RAM) running 24/7.",
            },
          };
        }

      case "database":
        if (componentId === "database") {
          const isRelational =
            nfr.dataNature.toLowerCase().includes("relational") ||
            nfr.dataNature.toLowerCase().includes("sql") ||
            nfr.dataNature.toLowerCase().includes("invoice");
          if (isRelational) {
            if (isLowBudget) {
              return {
                serviceName: "Amazon RDS PostgreSQL (db.t4g.micro)",
                alternatives: [
                  {
                    serviceName: "Amazon Aurora Serverless v2",
                    reason: "Chose RDS single instance because Aurora Serverless v2 has a minimum 0.5 ACU baseline cost (~$40/month), which exceeds the tight budget limit.",
                    costEstimate: {
                      min: 40,
                      max: isHighScale ? 300 : 100,
                      assumptions: "Aurora Serverless v2 scaling between 0.5 and 4 ACUs with Multi-AZ replication.",
                    },
                  },
                ],
                costEstimate: {
                  min: 15,
                  max: 25,
                  assumptions: "Single db.t4g.micro instance (2 vCPU, 1GB RAM) with 20GB GP3 storage.",
                },
              };
            } else {
              return {
                serviceName: "Amazon Aurora PostgreSQL (Serverless v2)",
                alternatives: [
                  {
                    serviceName: "Amazon RDS PostgreSQL (Multi-AZ)",
                    reason: "Chose Aurora Serverless v2 to accommodate unpredictable scaling automatically. RDS Multi-AZ would provide HA but is less flexible.",
                    costEstimate: {
                      min: 15,
                      max: 25,
                      assumptions: "Single db.t4g.micro instance (2 vCPU, 1GB RAM) with 20GB GP3 storage.",
                    },
                  },
                ],
                costEstimate: {
                  min: 40,
                  max: isHighScale ? 300 : 100,
                  assumptions: "Aurora Serverless v2 scaling between 0.5 and 4 ACUs with Multi-AZ replication.",
                },
              };
            }
          } else {
            return {
              serviceName: "Amazon DynamoDB",
              alternatives: [
                {
                  serviceName: "Amazon DocumentDB (MongoDB Compatible)",
                  reason: "Chose DynamoDB because DocumentDB requires a running cluster instance (~$50/month minimum), whereas DynamoDB is serverless and pay-as-you-go.",
                  costEstimate: {
                    min: 50,
                    max: isHighScale ? 250 : 80,
                    assumptions: "Amazon DocumentDB db.t3.medium instance cluster (~$50/month minimum) plus storage/IO costs.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 100 : 15,
                assumptions: "DynamoDB On-Demand read/write request units + storage capacity costs.",
              },
            };
          }
        }
        return {
          serviceName: "Amazon RDS PostgreSQL",
          alternatives: [{
            serviceName: "Amazon DynamoDB",
            reason: "Chose RDS for structured schemas.",
            costEstimate: {
              min: 0,
              max: isHighScale ? 100 : 15,
              assumptions: "DynamoDB On-Demand read/write request units + storage capacity costs.",
            },
          }],
          costEstimate: { min: 15, max: 50, assumptions: "RDS DB instance." },
        };

      case "storage":
        return {
          serviceName: "Amazon S3",
          alternatives: [
            {
              serviceName: "Amazon EFS (Elastic File System)",
              reason: "Chose S3 because the files are unstructured media/blobs. EFS is better for POSIX-compliant file systems mounted directly onto EC2/Fargate.",
              costEstimate: {
                min: 5,
                max: isHighScale ? 150 : 30,
                assumptions: "Amazon EFS Standard storage ($0.30/GB) for POSIX-compliant file access, no request-based fees.",
              },
            },
          ],
          costEstimate: {
            min: 1,
            max: isHighScale ? 80 : 15,
            assumptions: "S3 Standard storage volume ($0.023/GB) + GET/PUT request API calls.",
          },
        };

      case "queue":
        return {
          serviceName: "Amazon SQS (Simple Queue Service)",
          alternatives: [
            {
              serviceName: "Amazon MSK (Managed Streaming for Apache Kafka)",
              reason: "Chose SQS because the workload has simple message buffer requirements. Kafka (MSK) is designed for high-throughput log streams and has a high minimum instance cost (~$200/month).",
              costEstimate: {
                min: 200,
                max: isHighScale ? 600 : 250,
                assumptions: "Amazon MSK provisioned broker cluster (minimum 2-3 kafka.t3.small brokers, ~$200/month baseline).",
              },
            },
          ],
          costEstimate: {
            min: 0,
            max: isHighScale ? 30 : 5,
            assumptions: "SQS request volume (first 1 million requests/month are free).",
          },
        };

      case "cache":
        return {
          serviceName: "Amazon ElastiCache (Redis OSS)",
          alternatives: [
            {
              serviceName: "Amazon DynamoDB Accelerator (DAX)",
              reason: "Chose ElastiCache Redis because it supports versatile cache structures (sessions, query caches). DAX is specifically optimized only for DynamoDB key caching.",
              costEstimate: {
                min: 36,
                max: isHighScale ? 150 : 60,
                assumptions: "DAX requires a minimum 3-node cluster (dax.t3.small) for the built-in HA quorum.",
              },
            },
          ],
          costEstimate: {
            min: 12,
            max: isHighScale ? 90 : 25,
            assumptions: "Single cache.t4g.micro node running Redis OSS for session caching.",
          },
        };

      case "auth":
        return {
          serviceName: "Amazon Cognito User Pools",
          alternatives: [
            {
              serviceName: "Auth0 / Clerk (SaaS Provider)",
              reason: "Chose Cognito for full AWS native integration and cost savings. Cognito is free for the first 50,000 monthly active users (MAUs), whereas Clerk/Auth0 have lower free limits.",
              costEstimate: {
                min: isHighScale ? 99 : 0,
                max: isHighScale ? 250 : 35,
                assumptions: "Auth0/Clerk paid tier pricing kicks in above ~1,000 MAUs on the free plan, then per-MAU billing.",
              },
            },
          ],
          costEstimate: {
            min: 0,
            max: isHighScale ? 40 : 0,
            assumptions: "Cognito User Pools pricing: 50,000 MAUs free, then $0.0055 per MAU.",
          },
        };

      case "tokenization":
        return {
          serviceName: "AWS KMS + Dedicated Tokenization Microservice (ECS Fargate)",
          alternatives: [
            {
              serviceName: "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
              reason: "Chose a self-managed KMS-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
              costEstimate: {
                min: 200,
                max: isHighScale ? 1500 : 500,
                assumptions: "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
              },
            },
          ],
          costEstimate: {
            min: 40,
            max: isHighScale ? 300 : 100,
            assumptions: "KMS key usage fees + a small dedicated Fargate task (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
          },
        };

      case "audit-log":
        return {
          serviceName: "Amazon S3 (Object Lock — Compliance Mode) + CloudTrail",
          alternatives: [
            {
              serviceName: "Amazon QLDB (Quantum Ledger Database)",
              reason: "Chose S3 Object Lock for cost-effective, provably immutable storage at scale. QLDB offers cryptographic verification of the full change history but at a materially higher baseline cost for simple append-only audit logging.",
              costEstimate: {
                min: 60,
                max: isHighScale ? 400 : 150,
                assumptions: "QLDB ledger with a small number of I/O request units and journal storage.",
              },
            },
          ],
          costEstimate: {
            min: 3,
            max: isHighScale ? 60 : 15,
            assumptions: "S3 Standard storage with Object Lock (Compliance mode) + CloudTrail management event logging (first trail free).",
          },
        };

      case "phi-vault":
        return {
          serviceName: "AWS HealthLake (FHIR-native PHI Store)",
          alternatives: [
            {
              serviceName: "Amazon RDS PostgreSQL (KMS-Encrypted, Dedicated PHI Instance)",
              reason: "Chose HealthLake because it's purpose-built for healthcare data (FHIR R4) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted RDS instance is cheaper and simpler if the data isn't already FHIR-structured.",
              costEstimate: {
                min: 20,
                max: isHighScale ? 250 : 80,
                assumptions: "Dedicated db.t4g.medium instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
              },
            },
          ],
          costEstimate: {
            min: 90,
            max: isHighScale ? 600 : 200,
            assumptions: "HealthLake data store charges based on stored FHIR resources plus API request volume.",
          },
        };

      case "deidentification":
        return {
          serviceName: "Amazon Comprehend Medical (PHI Detection & De-identification)",
          alternatives: [
            {
              serviceName: "AWS Glue DataBrew (Custom Masking Rules)",
              reason: "Chose Comprehend Medical because it uses NLP trained specifically to detect the 18 HIPAA identifiers in unstructured clinical text. DataBrew is cheaper for simple structured-field masking but requires hand-authored rules per field.",
              costEstimate: {
                min: 5,
                max: isHighScale ? 80 : 25,
                assumptions: "DataBrew job runs on a nightly batch schedule processing the PHI vault export.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 150 : 40,
            assumptions: "Comprehend Medical priced per unit of text processed ($0.0010/100 characters), run as a nightly batch job over new PHI records.",
          },
        };

      default:
        return {
          serviceName: `AWS Mapped Service (${componentType})`,
          alternatives: [],
          costEstimate: { min: 0, max: 0, assumptions: "Generic AWS component." },
        };
    }
  } else if (provider === "azure") {
    switch (componentType) {
      case "cdn":
        return {
          serviceName: "Azure Front Door",
          alternatives: [
            {
              serviceName: "Azure Traffic Manager",
              reason: "Chose Azure Front Door because it provides Global HTTP/HTTPS load balancing and edge asset caching, whereas Traffic Manager is purely DNS-based routing.",
              costEstimate: {
                min: 1,
                max: isHighScale ? 15 : 5,
                assumptions: "Azure Traffic Manager DNS-based routing profile ($0.50/million DNS queries), no data transfer/caching fees since it does not proxy traffic.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 35 : 10,
            max: isHighScale ? 160 : 35,
            assumptions: "Azure Front Door Standard base fee ($35/mo) + data egress charges.",
          },
        };

      case "compute":
        if (componentId === "worker") {
          if (isLowBudget) {
            return {
              serviceName: "Azure Functions (Consumption Worker)",
              alternatives: [
                {
                  serviceName: "Azure Container Apps (Worker)",
                  reason: "Chose Azure Functions because it scales down to zero dynamically for background triggers. Container Apps would require a persistent active container profile.",
                  costEstimate: {
                    min: 15,
                    max: isHighScale ? 120 : 30,
                    assumptions: "Container profile allocating 0.25 vCPU and 0.5 GB RAM running continuously.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 35 : 5,
                assumptions: "Serverless execution duration pricing based on invocation volumes.",
              },
            };
          } else {
            return {
              serviceName: "Azure Container Apps (Worker)",
              alternatives: [
                {
                  serviceName: "Azure Virtual Machines (Scale Sets)",
                  reason: "Chose Container Apps to avoid VM management, OS upgrades, and complex scale rules. VMs would be cheaper but require significant administrative overhead.",
                  costEstimate: {
                    min: 8,
                    max: isHighScale ? 65 : 18,
                    assumptions: "Azure VM Scale Set with a single reserved B-series burstable instance, cheaper than Container Apps but requires manual patching and scaling.",
                  },
                },
              ],
              costEstimate: {
                min: 15,
                max: isHighScale ? 120 : 30,
                assumptions: "Container profile allocating 0.25 vCPU and 0.5 GB RAM running continuously.",
              },
            };
          }
        }

        // Primary API Compute
        const isServerlessRules =
          isLowBudget &&
          (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");
        if (isServerlessRules) {
          return {
            serviceName: "Azure Functions + API Management",
            alternatives: [
              {
                serviceName: "Azure Container Apps",
                reason: "Chose Azure Functions to minimize fixed costs, charging strictly per request. Container Apps has a slightly higher base footprint cost.",
                costEstimate: {
                  min: 25,
                  max: isHighScale ? 260 : 65,
                  assumptions: "Azure App Gateway baseline costs ($18/mo) + Container App execution (1-2 replicas).",
                },
              },
            ],
            costEstimate: {
              min: 0,
              max: isHighScale ? 85 : 10,
              assumptions: "API Management Consumption tier + Serverless Functions executions.",
            },
          };
        } else {
          return {
            serviceName: "Azure Container Apps + App Gateway",
            alternatives: [
              {
                serviceName: "Azure App Service (Linux Web App)",
                reason: "Chose Container Apps for modern microservices packaging and simpler scale-to-zero settings compared to App Service plans.",
                costEstimate: {
                  min: 0,
                  max: isHighScale ? 85 : 10,
                  assumptions: "API Management Consumption tier + Serverless Functions executions.",
                },
              },
            ],
            costEstimate: {
              min: 25,
              max: isHighScale ? 260 : 65,
              assumptions: "Azure App Gateway baseline costs ($18/mo) + Container App execution (1-2 replicas).",
            },
          };
        }

      case "database":
        if (componentId === "database") {
          const isRelational =
            nfr.dataNature.toLowerCase().includes("relational") ||
            nfr.dataNature.toLowerCase().includes("sql") ||
            nfr.dataNature.toLowerCase().includes("invoice");
          if (isRelational) {
            if (isLowBudget) {
              return {
                serviceName: "Azure Database for PostgreSQL (Burstable B1ms)",
                alternatives: [
                  {
                    serviceName: "Azure Cosmos DB (PostgreSQL API)",
                    reason: "Chose Burstable PostgreSQL single instance because Cosmos DB distributed configurations have a high baseline cost structure (~$90/mo minimum).",
                    costEstimate: {
                      min: 45,
                      max: isHighScale ? 310 : 110,
                      assumptions: "General Purpose D2ds_v5 instance (2 vCPU, 8GB RAM) with high availability configured.",
                    },
                  },
                ],
                costEstimate: {
                  min: 15,
                  max: 25,
                  assumptions: "Single burstable compute instance (B1ms, 1 vCPU, 2GB RAM) with 32GB Premium SSD storage.",
                },
              };
            } else {
              return {
                serviceName: "Azure Database for PostgreSQL (Flexible Server)",
                alternatives: [
                  {
                    serviceName: "Azure Cosmos DB for PostgreSQL",
                    reason: "Chose PostgreSQL Flexible Server to provide high availability and replication zones without the complexity of a distributed Citus database layout.",
                    costEstimate: {
                      min: 15,
                      max: 25,
                      assumptions: "Single burstable compute instance (B1ms, 1 vCPU, 2GB RAM) with 32GB Premium SSD storage.",
                    },
                  },
                ],
                costEstimate: {
                  min: 45,
                  max: isHighScale ? 310 : 110,
                  assumptions: "General Purpose D2ds_v5 instance (2 vCPU, 8GB RAM) with high availability configured.",
                },
              };
            }
          } else {
            return {
              serviceName: "Azure Cosmos DB (NoSQL)",
              alternatives: [
                {
                  serviceName: "Azure Cache for Redis (Enterprise)",
                  reason: "Chose Cosmos DB as the primary document store due to strict document query requirements. Redis is used primarily for fast transit caches.",
                  costEstimate: {
                    min: 100,
                    max: isHighScale ? 500 : 200,
                    assumptions: "Azure Cache for Redis Enterprise E10 tier minimum footprint for advanced modules and higher throughput.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 110 : 15,
                assumptions: "Cosmos DB Serverless provisioning (billing based on consumed Request Units).",
              },
            };
          }
        }
        return {
          serviceName: "Azure Database for PostgreSQL",
          alternatives: [{
            serviceName: "Azure Cosmos DB",
            reason: "Chose PostgreSQL for relational data model.",
            costEstimate: {
              min: 0,
              max: isHighScale ? 110 : 15,
              assumptions: "Cosmos DB Serverless provisioning (billing based on consumed Request Units).",
            },
          }],
          costEstimate: { min: 15, max: 50, assumptions: "Azure PostgreSQL Server." },
        };

      case "storage":
        return {
          serviceName: "Azure Blob Storage (LRS GPv2)",
          alternatives: [
            {
              serviceName: "Azure Files",
              reason: "Chose Blob Storage because the application requires flat block media objects. Azure Files is optimized for SMB/NFS file share mounts.",
              costEstimate: {
                min: 6,
                max: isHighScale ? 160 : 35,
                assumptions: "Azure Files Premium tier ($0.16/GB-provisioned) for SMB/NFS mounts, provisioned capacity billed regardless of usage.",
              },
            },
          ],
          costEstimate: {
            min: 1,
            max: isHighScale ? 85 : 15,
            assumptions: "Hot Tier blob storage capacity costs ($0.018/GB) + transactional operations.",
          },
        };

      case "queue":
        return {
          serviceName: "Azure Service Bus (Standard)",
          alternatives: [
            {
              serviceName: "Azure Queue Storage",
              reason: "Chose Service Bus Standard because it supports advanced FIFO, transactions, and pub/sub routing. Queue Storage is cheaper but supports only basic queuing.",
              costEstimate: {
                min: 0,
                max: isHighScale ? 10 : 3,
                assumptions: "Azure Queue Storage pay-per-operation pricing ($0.0036/10k operations), no fixed monthly base fee.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 35 : 15,
            assumptions: "Service Bus Standard base price ($10/mo) which includes 10 million transactions.",
          },
        };

      case "cache":
        return {
          serviceName: "Azure Cache for Redis (Basic C0)",
          alternatives: [
            {
              serviceName: "Azure Cosmos DB Integrated Cache",
              reason: "Chose Redis because it supports multi-service session and schema caches. Cosmos DB integrated cache is restricted purely to Cosmos DB reads.",
              costEstimate: {
                min: 0,
                max: isHighScale ? 60 : 15,
                assumptions: "Cosmos DB Integrated Cache billed as additional RU consumption on the existing Cosmos DB account, no standalone node cost.",
              },
            },
          ],
          costEstimate: {
            min: 16,
            max: isHighScale ? 95 : 30,
            assumptions: "Basic tier C0 instance (250MB RAM) for low latency key caching.",
          },
        };

      case "auth":
        return {
          serviceName: "Microsoft Entra ID B2C",
          alternatives: [
            {
              serviceName: "Auth0 / Clerk SaaS",
              reason: "Chose Entra ID B2C due to its generous free tier limit (50,000 monthly active users) and direct Microsoft ecosystem integration.",
              costEstimate: {
                min: isHighScale ? 99 : 0,
                max: isHighScale ? 250 : 35,
                assumptions: "Auth0/Clerk paid tier pricing kicks in above ~1,000 MAUs on the free plan, then per-MAU billing.",
              },
            },
          ],
          costEstimate: {
            min: 0,
            max: isHighScale ? 40 : 0,
            assumptions: "Entra ID B2C pricing: 50,000 MAUs free, then standard verification fees.",
          },
        };

      case "tokenization":
        return {
          serviceName: "Azure Key Vault + Dedicated Tokenization Microservice (Container Apps)",
          alternatives: [
            {
              serviceName: "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
              reason: "Chose a self-managed Key Vault-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
              costEstimate: {
                min: 200,
                max: isHighScale ? 1500 : 500,
                assumptions: "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
              },
            },
          ],
          costEstimate: {
            min: 45,
            max: isHighScale ? 310 : 110,
            assumptions: "Key Vault Premium (HSM-backed keys) + a small dedicated Container App (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
          },
        };

      case "audit-log":
        return {
          serviceName: "Azure Blob Storage (Immutable/WORM Policy) + Azure Monitor",
          alternatives: [
            {
              serviceName: "Azure Data Explorer (Audit Log Analytics)",
              reason: "Chose Blob Storage with an immutability policy for cost-effective, provably immutable storage at scale. Data Explorer offers rich query analytics over the log history but at a materially higher baseline cost for simple append-only audit logging.",
              costEstimate: {
                min: 60,
                max: isHighScale ? 400 : 150,
                assumptions: "Data Explorer cluster with minimum compute SKU running continuously for log ingestion and query.",
              },
            },
          ],
          costEstimate: {
            min: 3,
            max: isHighScale ? 60 : 15,
            assumptions: "Blob Storage Hot tier with a time-based immutability policy + Azure Monitor log ingestion.",
          },
        };

      case "phi-vault":
        return {
          serviceName: "Azure Health Data Services (FHIR API)",
          alternatives: [
            {
              serviceName: "Azure Database for PostgreSQL (Encrypted, Dedicated PHI Instance)",
              reason: "Chose Health Data Services because it's purpose-built for healthcare data (FHIR R4) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted PostgreSQL instance is cheaper and simpler if the data isn't already FHIR-structured.",
              costEstimate: {
                min: 20,
                max: isHighScale ? 250 : 80,
                assumptions: "Dedicated Burstable B2ms instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
              },
            },
          ],
          costEstimate: {
            min: 90,
            max: isHighScale ? 600 : 200,
            assumptions: "Health Data Services FHIR service charges based on stored resources plus API request volume.",
          },
        };

      case "deidentification":
        return {
          serviceName: "Azure Health Data De-identification Service",
          alternatives: [
            {
              serviceName: "Azure Purview (Data Classification + Masking)",
              reason: "Chose the purpose-built Health Data De-identification service because it directly implements the HIPAA Safe Harbor and Expert Determination methods. Purview is a more general data-governance/classification tool that needs custom masking rules configured per field.",
              costEstimate: {
                min: 5,
                max: isHighScale ? 80 : 25,
                assumptions: "Purview data map + classification scan running on a nightly batch schedule over the PHI vault export.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 150 : 40,
            assumptions: "De-identification service priced per document/text unit processed, run as a nightly batch job over new PHI records.",
          },
        };

      default:
        return {
          serviceName: `Azure Mapped Service (${componentType})`,
          alternatives: [],
          costEstimate: { min: 0, max: 0, assumptions: "Generic Azure component." },
        };
    }
  } else if (provider === "gcp") {
    switch (componentType) {
      case "cdn":
        return {
          serviceName: "Google Cloud CDN",
          alternatives: [
            {
              serviceName: "Google Cloud Load Balancing (Anycast)",
              reason: "Chose Cloud CDN because it caches static images and assets at Google edge nodes. Raw Load Balancing only handles request routing without caching.",
              costEstimate: {
                min: isHighScale ? 18 : 5,
                max: isHighScale ? 90 : 20,
                assumptions: "Global external HTTPS Load Balancer forwarding rule + data processing fees, without edge cache offload.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 15 : 5,
            max: isHighScale ? 130 : 15,
            assumptions: "Cache lookup costs + Cloud CDN data egress fees.",
          },
        };

      case "compute":
        if (componentId === "worker") {
          if (isLowBudget) {
            return {
              serviceName: "Google Cloud Functions (Worker)",
              alternatives: [
                {
                  serviceName: "Google Cloud Run (Worker Task)",
                  reason: "Chose Cloud Functions because it is optimized for brief, event-driven processes. Cloud Run is better for microservices that handle web traffic.",
                  costEstimate: {
                    min: 12,
                    max: isHighScale ? 110 : 25,
                    assumptions: "Container instance with 0.25 vCPU and 0.5 GB RAM running continuously.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 30 : 5,
                assumptions: "Cloud Functions executions duration billing based on request triggers.",
              },
            };
          } else {
            return {
              serviceName: "Google Cloud Run (Worker)",
              alternatives: [
                {
                  serviceName: "Google Compute Engine (VM Instances)",
                  reason: "Chose Cloud Run to enjoy container management abstractions and automatic scaling down to zero. VMs require active operating system patching.",
                  costEstimate: {
                    min: 6,
                    max: isHighScale ? 55 : 15,
                    assumptions: "Google Compute Engine e2-micro/small instance running continuously, cheaper than Cloud Run but requires manual patching and scaling.",
                  },
                },
              ],
              costEstimate: {
                min: 12,
                max: isHighScale ? 110 : 25,
                assumptions: "Container instance with 0.25 vCPU and 0.5 GB RAM running continuously.",
              },
            };
          }
        }

        // Primary API Compute
        const isServerlessRules =
          isLowBudget &&
          (teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified");
        if (isServerlessRules) {
          return {
            serviceName: "Google Cloud Functions + API Gateway",
            alternatives: [
              {
                serviceName: "Google Cloud Run",
                reason: "Chose Cloud Functions for minimal serverless orchestration overhead. Cloud Run is serverless but requires containerizing the API.",
                costEstimate: {
                  min: 20,
                  max: isHighScale ? 240 : 60,
                  assumptions: "GCP Global HTTPS Load Balancer baseline cost ($18/mo) + Cloud Run CPU allocation.",
                },
              },
            ],
            costEstimate: {
              min: 0,
              max: isHighScale ? 80 : 10,
              assumptions: "API Gateway request pricing + Cloud Functions executions duration costs.",
            },
          };
        } else {
          return {
            serviceName: "Google Cloud Run + HTTPS Load Balancer",
            alternatives: [
              {
                serviceName: "Google Kubernetes Engine (GKE Autopilot)",
                reason: "Chose Cloud Run for container deployment simplicity without GKE cluster management. GKE is better for complex multi-container pods.",
                costEstimate: {
                  min: 70,
                  max: isHighScale ? 400 : 150,
                  assumptions: "GKE Autopilot cluster management fee ($0.10/hour, ~$73/mo) plus pod resource allocation.",
                },
              },
            ],
            costEstimate: {
              min: 20,
              max: isHighScale ? 240 : 60,
              assumptions: "GCP Global HTTPS Load Balancer baseline cost ($18/mo) + Cloud Run CPU allocation.",
            },
          };
        }

      case "database":
        if (componentId === "database") {
          const isRelational =
            nfr.dataNature.toLowerCase().includes("relational") ||
            nfr.dataNature.toLowerCase().includes("sql") ||
            nfr.dataNature.toLowerCase().includes("invoice");
          if (isRelational) {
            if (isLowBudget) {
              return {
                serviceName: "Google Cloud SQL for PostgreSQL (db-f1-micro)",
                alternatives: [
                  {
                    serviceName: "Google Cloud Spanner",
                    reason: "Chose Cloud SQL for small PostgreSQL database needs. Cloud Spanner is a globally distributed SQL DB with high minimum costs (~$60/mo).",
                    costEstimate: {
                      min: 60,
                      max: isHighScale ? 400 : 150,
                      assumptions: "Cloud Spanner minimum 1 processing unit node (~$60/month), intended for globally distributed multi-region workloads.",
                    },
                  },
                ],
                costEstimate: {
                  min: 10,
                  max: 20,
                  assumptions: "Shared-core db-f1-micro instance (1 vCPU, 0.6GB RAM) with 20GB SSD storage.",
                },
              };
            } else {
              return {
                serviceName: "Google Cloud SQL for PostgreSQL (db-custom-1-3840)",
                alternatives: [
                  {
                    serviceName: "Google Cloud Spanner",
                    reason: "Chose Cloud SQL Flexible PostgreSQL for high-performance relational features. Cloud Spanner is reserved for massive multi-region database replication.",
                    costEstimate: {
                      min: 60,
                      max: isHighScale ? 400 : 150,
                      assumptions: "Cloud Spanner minimum 1 processing unit node (~$60/month), intended for globally distributed multi-region workloads.",
                    },
                  },
                ],
                costEstimate: {
                  min: 35,
                  max: isHighScale ? 280 : 90,
                  assumptions: "Dedicated custom vCPU instance (1 vCPU, 3.75GB RAM) with HA cluster configured.",
                },
              };
            }
          } else {
            return {
              serviceName: "Google Cloud Firestore",
              alternatives: [
                {
                  serviceName: "Google Cloud Bigtable",
                  reason: "Chose Firestore as the flexible NoSQL document database. Bigtable is a wide-column store designed for multi-terabyte analytical databases.",
                  costEstimate: {
                    min: 450,
                    max: isHighScale ? 1500 : 600,
                    assumptions: "Cloud Bigtable requires a minimum 1-node cluster (~$450/month) regardless of traffic, intended for multi-terabyte analytical workloads.",
                  },
                },
              ],
              costEstimate: {
                min: 0,
                max: isHighScale ? 100 : 15,
                assumptions: "Firestore serverless pricing based on read, write, and delete counts.",
              },
            };
          }
        }
        return {
          serviceName: "Google Cloud SQL for PostgreSQL",
          alternatives: [{
            serviceName: "Google Cloud Firestore",
            reason: "Chose Cloud SQL for relational storage.",
            costEstimate: {
              min: 0,
              max: isHighScale ? 100 : 15,
              assumptions: "Firestore serverless pricing based on read, write, and delete counts.",
            },
          }],
          costEstimate: { min: 10, max: 45, assumptions: "Cloud SQL PostgreSQL instance." },
        };

      case "storage":
        return {
          serviceName: "Google Cloud Storage (Standard)",
          alternatives: [
            {
              serviceName: "Google Cloud Filestore",
              reason: "Chose Cloud Storage Standard because the data is flat media/image uploads. Filestore provides POSIX network-attached storage mounts for VMs.",
              costEstimate: {
                min: 200,
                max: isHighScale ? 600 : 250,
                assumptions: "Filestore Basic tier requires a minimum 1TB provisioned instance (~$200/month) for POSIX network-attached storage.",
              },
            },
          ],
          costEstimate: {
            min: 1,
            max: isHighScale ? 80 : 15,
            assumptions: "Standard storage capacity cost ($0.020/GB) + egress network charges.",
          },
        };

      case "queue":
        return {
          serviceName: "Google Cloud Pub/Sub",
          alternatives: [
            {
              serviceName: "Google Cloud Tasks",
              reason: "Chose Pub/Sub because it provides high-throughput, fan-out event pub/sub. Cloud Tasks is better for targeted queue HTTP executions (cron tasks).",
              costEstimate: {
                min: 0,
                max: isHighScale ? 15 : 5,
                assumptions: "Cloud Tasks per-operation pricing ($0.40/million operations after the free tier), intended for targeted HTTP-triggered queues.",
              },
            },
          ],
          costEstimate: {
            min: 0,
            max: isHighScale ? 30 : 5,
            assumptions: "Pub/Sub message volume (first 10GB of data transfer is free/month).",
          },
        };

      case "cache":
        return {
          serviceName: "Google Cloud Memorystore (Redis)",
          alternatives: [
            {
              serviceName: "Google Cloud Bigtable",
              reason: "Chose Memorystore for fast Redis caching. Bigtable can serve as a key-value store but is far more expensive and heavier than cache instances.",
              costEstimate: {
                min: 450,
                max: isHighScale ? 1500 : 600,
                assumptions: "Cloud Bigtable requires a minimum 1-node cluster (~$450/month), far exceeding typical cache-node costs.",
              },
            },
          ],
          costEstimate: {
            min: 15,
            max: isHighScale ? 90 : 25,
            assumptions: "Basic tier M1 Memorystore instance (1GB RAM capacity) running Redis.",
          },
        };

      case "auth":
        return {
          serviceName: "Firebase Authentication",
          alternatives: [
            {
              serviceName: "Google Cloud Identity Platform",
              reason: "Chose Firebase Authentication due to its generous free tier (50,000 MAUs free) and easy setup. Identity Platform provides advanced enterprise features at cost.",
              costEstimate: {
                min: isHighScale ? 99 : 0,
                max: isHighScale ? 250 : 35,
                assumptions: "Identity Platform enterprise features (SAML/OIDC federation, MFA) billed per-MAU above the free Firebase Auth tier.",
              },
            },
          ],
          costEstimate: {
            min: 0,
            max: isHighScale ? 40 : 0,
            assumptions: "Firebase Authentication free for standard phone/email accounts up to 50k MAUs.",
          },
        };

      case "tokenization":
        return {
          serviceName: "Google Cloud KMS + Dedicated Tokenization Microservice (Cloud Run)",
          alternatives: [
            {
              serviceName: "Third-Party Tokenization Vault (e.g. Basis Theory, VGS)",
              reason: "Chose a self-managed KMS-backed microservice to keep full control of the tokenization boundary. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
              costEstimate: {
                min: 200,
                max: isHighScale ? 1500 : 500,
                assumptions: "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
              },
            },
          ],
          costEstimate: {
            min: 35,
            max: isHighScale ? 280 : 90,
            assumptions: "Cloud KMS key usage fees + a small dedicated Cloud Run service (0.25 vCPU, 0.5GB RAM) running the tokenization service continuously.",
          },
        };

      case "audit-log":
        return {
          serviceName: "Google Cloud Storage (Bucket Lock — Immutable) + Cloud Audit Logs",
          alternatives: [
            {
              serviceName: "Google Cloud Logging (Log Analytics)",
              reason: "Chose Cloud Storage with Bucket Lock for cost-effective, provably immutable storage at scale. Log Analytics offers rich SQL-based querying over the log history but at a materially higher baseline cost for simple append-only audit logging.",
              costEstimate: {
                min: 60,
                max: isHighScale ? 400 : 150,
                assumptions: "Log Analytics-linked bucket with extended retention and BigQuery-style query volume.",
              },
            },
          ],
          costEstimate: {
            min: 3,
            max: isHighScale ? 60 : 15,
            assumptions: "Cloud Storage Standard tier with a Bucket Lock retention policy + Cloud Audit Logs (Admin Activity logs are free).",
          },
        };

      case "phi-vault":
        return {
          serviceName: "Google Cloud Healthcare API (FHIR Store)",
          alternatives: [
            {
              serviceName: "Google Cloud SQL for PostgreSQL (Encrypted, Dedicated PHI Instance)",
              reason: "Chose the Healthcare API because it's purpose-built for healthcare data (FHIR/HL7v2/DICOM) with built-in HIPAA-eligible encryption and query tooling. A dedicated encrypted Cloud SQL instance is cheaper and simpler if the data isn't already FHIR-structured.",
              costEstimate: {
                min: 20,
                max: isHighScale ? 250 : 80,
                assumptions: "Dedicated db-custom-1-3840 instance (KMS-encrypted) with 50GB storage, isolated from the general application database.",
              },
            },
          ],
          costEstimate: {
            min: 90,
            max: isHighScale ? 600 : 200,
            assumptions: "Healthcare API FHIR store charges based on stored resources plus API request/storage volume.",
          },
        };

      case "deidentification":
        return {
          serviceName: "Google Cloud DLP API (De-identification Templates)",
          alternatives: [
            {
              serviceName: "Cloud Healthcare API De-identify Operation",
              reason: "Chose the standalone DLP API for flexible, reusable de-identification templates across any text/structured source. The Healthcare API's built-in de-identify operation is more convenient when the PHI is already stored as FHIR resources in the same service.",
              costEstimate: {
                min: 8,
                max: isHighScale ? 120 : 35,
                assumptions: "Healthcare API de-identify operation priced per FHIR resource processed, run as a nightly batch job.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 150 : 40,
            assumptions: "Cloud DLP API priced per unit of data inspected/transformed, run as a nightly batch job over new PHI records.",
          },
        };

      default:
        return {
          serviceName: `GCP Mapped Service (${componentType})`,
          alternatives: [],
          costEstimate: { min: 0, max: 0, assumptions: "Generic GCP component." },
        };
    }
  } else if (provider === "kubernetes") {
    // Cloud-agnostic — costs here are infrastructure share (pod resource requests, PVs) on
    // top of cluster capacity you provision separately (EKS/GKE/AKS/self-hosted), not managed
    // service billing. isLowOpsCapacity mirrors rules-engine.ts's isTeamJunior/isBudgetTight
    // logic to decide when to steer toward an external managed dependency instead of
    // self-hosting stateful workloads on the cluster.
    const isLowOpsCapacity =
      isLowBudget || teamLower.includes("junior") || teamLower.includes("small") || teamLower === "not_specified";

    switch (componentType) {
      case "cdn":
        return {
          serviceName: "Ingress-NGINX + cert-manager (Cluster-Level TLS)",
          alternatives: [
            {
              serviceName: "External CDN (Cloudflare/Fastly) in Front of Ingress",
              reason: "Chose in-cluster Ingress-NGINX for a fully self-contained setup. An external CDN adds real edge caching/offload for static assets but introduces a dependency outside the cluster and its own billing.",
              costEstimate: {
                min: isHighScale ? 20 : 0,
                max: isHighScale ? 150 : 20,
                assumptions: "Third-party CDN usage-based pricing layered in front of the cluster Ingress for static asset offload.",
              },
            },
          ],
          costEstimate: {
            min: 5,
            max: isHighScale ? 40 : 15,
            assumptions: "Ingress-NGINX controller (2 replicas) + cert-manager pods running within existing cluster capacity — incremental infra cost only, no edge network.",
          },
        };

      case "compute":
        if (componentId === "worker") {
          return {
            serviceName: "Deployment (Worker Pool) + KEDA (Event-Driven Autoscaling)",
            alternatives: [
              {
                serviceName: "CronJob (Scheduled/Batch-Only Workers)",
                reason: "Chose KEDA to scale worker pods in direct response to queue depth. A CronJob is simpler and cheaper but only suits fixed-schedule batch work, not reactive queue processing.",
                costEstimate: {
                  min: 5,
                  max: isHighScale ? 60 : 20,
                  assumptions: "CronJob pods only run on their configured schedule, so cost is proportional to job duration rather than continuous replica count.",
                },
              },
            ],
            costEstimate: {
              min: 10,
              max: isHighScale ? 150 : 40,
              assumptions: "Worker pod resource requests scaled by KEDA based on queue depth, plus the KEDA operator's own small footprint.",
            },
          };
        }

        return {
          serviceName: "Deployment + HorizontalPodAutoscaler (HPA)",
          alternatives: [
            {
              serviceName: "Knative Serving (Scale-to-Zero)",
              reason: "Chose standard Deployment+HPA for predictable steady-state load. Knative Serving scales pods to zero when idle, which suits spiky/intermittent traffic better, but adds cold-start latency and an extra control-plane component to operate.",
              costEstimate: {
                min: 0,
                max: isHighScale ? 300 : 80,
                assumptions: "Knative Serving scales to zero replicas when idle, so cost tracks actual request volume rather than a constant baseline.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 60 : 15,
            max: isHighScale ? 400 : 100,
            assumptions: "Pod resource requests (CPU/memory) as a share of overall cluster node cost; assumes cluster capacity is provisioned/billed separately.",
          },
        };

      case "database":
        if (isLowOpsCapacity) {
          return {
            serviceName: "External Managed Database (e.g. RDS/Cloud SQL) + K8s Secret Binding",
            alternatives: [
              {
                serviceName: "StatefulSet (Self-Managed PostgreSQL, e.g. CloudNativePG)",
                reason: "Strongly recommended external managed database given the team's low operational maturity/tight budget — self-managing a stateful database on Kubernetes (failover, backups, patching, upgrades) is a significant ops burden that a managed service absorbs for you.",
                costEstimate: {
                  min: 20,
                  max: isHighScale ? 200 : 60,
                  assumptions: "Persistent volume storage + pod resource requests for a self-managed PostgreSQL StatefulSet (e.g. via the CloudNativePG operator); excludes managed-service reliability guarantees.",
                },
              },
            ],
            costEstimate: {
              min: 15,
              max: isHighScale ? 300 : 100,
              assumptions: "External managed database service billed by whichever cloud host the cluster runs on, connected in via an ExternalName Service + Kubernetes Secret.",
            },
          };
        }
        return {
          serviceName: "StatefulSet (Self-Managed PostgreSQL, e.g. CloudNativePG)",
          alternatives: [
            {
              serviceName: "External Managed Database (e.g. RDS/Cloud SQL) + K8s Secret Binding",
              reason: "Chose self-managed for full control and to avoid a dependency outside the cluster, given adequate operational maturity to run it. A managed database removes failover/backup/patching burden entirely at the cost of that control.",
              costEstimate: {
                min: 15,
                max: isHighScale ? 300 : 100,
                assumptions: "External managed database service billed by whichever cloud host the cluster runs on, connected in via an ExternalName Service + Kubernetes Secret.",
              },
            },
          ],
          costEstimate: {
            min: 20,
            max: isHighScale ? 200 : 60,
            assumptions: "Persistent volume storage + pod resource requests for a self-managed PostgreSQL StatefulSet (e.g. via the CloudNativePG operator); excludes managed-service reliability guarantees.",
          },
        };

      case "storage":
        return {
          serviceName: "MinIO (Self-Hosted S3-Compatible, Helm Chart)",
          alternatives: [
            {
              serviceName: "External Object Storage (e.g. S3/GCS) via K8s Secret",
              reason: "Chose MinIO to keep object storage inside the cluster's own infrastructure footprint. An external provider removes disk capacity planning and backup responsibility for the object store entirely.",
              costEstimate: {
                min: 1,
                max: isHighScale ? 80 : 15,
                assumptions: "External object storage billed by the cloud host, connected in via a Kubernetes Secret holding provider credentials.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 120 : 40,
            assumptions: "MinIO StatefulSet with persistent volumes for object storage; requires its own disk capacity provisioning and backup strategy.",
          },
        };

      case "queue":
        return {
          serviceName: "RabbitMQ (Helm Chart, Bitnami)",
          alternatives: [
            {
              serviceName: "NATS JetStream (Helm Chart)",
              reason: "Chose RabbitMQ for its mature tooling and broad client library support. NATS JetStream is lighter-weight and higher-throughput but has a smaller operational ecosystem and less mature management tooling.",
              costEstimate: {
                min: 8,
                max: isHighScale ? 100 : 30,
                assumptions: "NATS JetStream StatefulSet (3-node cluster) with persistent volumes — generally lighter resource footprint than RabbitMQ.",
              },
            },
          ],
          costEstimate: {
            min: 15,
            max: isHighScale ? 150 : 40,
            assumptions: "RabbitMQ StatefulSet (3-node cluster for HA) via the Bitnami Helm chart, with persistent volumes.",
          },
        };

      case "cache":
        return {
          serviceName: "Redis (Helm Chart, Bitnami)",
          alternatives: [
            {
              serviceName: "External Managed Cache (e.g. ElastiCache/Memorystore)",
              reason: "Chose self-managed Redis to avoid a dependency outside the cluster. A managed cache removes node failover and version-upgrade responsibility at the cost of that independence.",
              costEstimate: {
                min: 12,
                max: isHighScale ? 90 : 25,
                assumptions: "Managed cache service billed by the cloud host, reached from in-cluster pods over a private network path.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 100 : 30,
            assumptions: "Redis StatefulSet (Bitnami Helm chart) with a persistent volume for optional AOF persistence.",
          },
        };

      case "auth":
        return {
          serviceName: "Keycloak (Helm Chart)",
          alternatives: [
            {
              serviceName: "External OIDC Provider (e.g. Auth0/Cognito)",
              reason: "Chose self-hosted Keycloak to keep identity fully inside the cluster's own infrastructure. An external OIDC provider removes the operational burden of running and patching an identity server at the cost of a per-MAU vendor fee.",
              costEstimate: {
                min: 0,
                max: isHighScale ? 250 : 35,
                assumptions: "External OIDC provider (e.g. Auth0/Cognito) paid-tier pricing above its free-tier MAU threshold.",
              },
            },
          ],
          costEstimate: {
            min: 15,
            max: isHighScale ? 100 : 35,
            assumptions: "Keycloak Deployment (2+ replicas for HA) backed by its own small PostgreSQL StatefulSet, via the Keycloak Operator or Bitnami Helm chart.",
          },
        };

      case "tokenization":
        return {
          serviceName: "HashiCorp Vault (Helm Chart) + Dedicated Tokenization Deployment",
          alternatives: [
            {
              serviceName: "External Tokenization Vault (e.g. Basis Theory, VGS)",
              reason: "Chose self-hosted Vault to keep the tokenization boundary and key material entirely inside cluster-managed infrastructure. A third-party vault offloads PCI-DSS scope entirely but adds a recurring per-transaction vendor fee and an external dependency in the payment path.",
              costEstimate: {
                min: 200,
                max: isHighScale ? 1500 : 500,
                assumptions: "Third-party tokenization vault per-transaction/per-token pricing plus a monthly platform fee.",
              },
            },
          ],
          costEstimate: {
            min: 40,
            max: isHighScale ? 350 : 120,
            assumptions: "Vault StatefulSet in HA mode (3 replicas, Raft storage backend) + a small dedicated tokenization Deployment.",
          },
        };

      case "audit-log":
        return {
          serviceName: "Falco + Audit Sink (Fluentd → Immutable Object Store)",
          alternatives: [
            {
              serviceName: "Self-Hosted SIEM (e.g. Wazuh)",
              reason: "Chose Falco for its purpose-built Kubernetes runtime security/audit event detection. A full SIEM like Wazuh offers broader correlation and alerting but is materially heavier to operate for audit-log-only needs.",
              costEstimate: {
                min: 30,
                max: isHighScale ? 250 : 90,
                assumptions: "Wazuh manager + indexer StatefulSets with persistent volumes for the full SIEM stack.",
              },
            },
          ],
          costEstimate: {
            min: 15,
            max: isHighScale ? 150 : 50,
            assumptions: "Falco DaemonSet (one pod per node, runtime audit events) + a Fluentd sidecar shipping logs to an immutable MinIO bucket or external object store.",
          },
        };

      case "phi-vault":
        return {
          serviceName: "Encrypted PVC (StorageClass: Encrypted) + Sealed Secrets",
          alternatives: [
            {
              serviceName: "External HIPAA-Eligible Managed Database",
              reason: "Chose an in-cluster encrypted PersistentVolumeClaim with Sealed Secrets for credential management to keep PHI inside cluster-managed infrastructure. An external managed database shifts encryption/backup/patching responsibility to the provider at the cost of a dependency outside the cluster.",
              costEstimate: {
                min: 20,
                max: isHighScale ? 250 : 80,
                assumptions: "External HIPAA-eligible managed database service billed by the cloud host, isolated in its own private subnet.",
              },
            },
          ],
          costEstimate: {
            min: 25,
            max: isHighScale ? 250 : 80,
            assumptions: "Dedicated StatefulSet backed by an encrypted-at-rest StorageClass (e.g. cloud-provider EBS/PD with KMS, or LUKS-encrypted local storage) + Sealed Secrets for credential management.",
          },
        };

      case "deidentification":
        return {
          serviceName: "Microsoft Presidio (Self-Hosted, Helm/Deployment)",
          alternatives: [
            {
              serviceName: "Batch CronJob with Custom NLP Masking Rules",
              reason: "Chose Presidio because it's a purpose-built open-source PHI/PII detection and anonymization toolkit. A hand-rolled CronJob with custom masking rules is cheaper to run but requires maintaining detection logic yourselves.",
              costEstimate: {
                min: 5,
                max: isHighScale ? 80 : 25,
                assumptions: "Lightweight CronJob pod running custom masking rules on a nightly schedule, no dedicated NLP model serving.",
              },
            },
          ],
          costEstimate: {
            min: 10,
            max: isHighScale ? 120 : 35,
            assumptions: "Presidio Analyzer + Anonymizer Deployments, invoked by a nightly CronJob-triggered batch process over new PHI records.",
          },
        };

      default:
        return {
          serviceName: `Kubernetes Mapped Workload (${componentType})`,
          alternatives: [],
          costEstimate: { min: 0, max: 0, assumptions: "Generic in-cluster workload." },
        };
    }
  } else if (provider === "private") {
    // On-premises / private cloud (VMware, OpenStack, bare-metal). Conservative by design:
    // no elastic autoscaling, no managed-service fallbacks — every stateful/managed dependency
    // that a public cloud would absorb becomes an explicit, flagged ops burden here. Cost bands
    // are amortized monthly hardware/licensing estimates, not cloud spend.
    switch (componentType) {
      case "cdn":
        return {
          serviceName: "Reverse Proxy (NGINX/HAProxy) — No CDN Edge Network On-Premises",
          alternatives: [
            {
              serviceName: "Hybrid: External CDN in Front of On-Prem Origin",
              reason: "Chose a plain reverse proxy since private infrastructure has no edge network of its own. Layering a commercial CDN (e.g. Cloudflare) in front of your on-prem origin restores edge caching at the cost of routing public traffic through a third party.",
              costEstimate: {
                min: isHighScale ? 20 : 0,
                max: isHighScale ? 150 : 20,
                assumptions: "Third-party CDN usage-based pricing layered in front of the on-prem origin.",
              },
            },
          ],
          costEstimate: {
            min: 5,
            max: 20,
            assumptions: "NGINX/HAProxy reverse-proxy VM(s). No edge caching network — static assets are served from origin unless a hybrid CDN is added in front.",
          },
        };

      case "compute":
        if (componentId === "worker") {
          return {
            serviceName: "Dedicated Worker VM Pool (Manual Scaling)",
            alternatives: [
              {
                serviceName: "Shared Compute Pool (Time-Sliced with API Workload)",
                reason: "Chose a dedicated worker VM pool for predictable background-job capacity. Sharing the compute pool with the API workload is cheaper but risks background jobs starving user-facing request latency during load spikes.",
                costEstimate: {
                  min: isHighScale ? 100 : 40,
                  max: isHighScale ? 400 : 150,
                  assumptions: "No dedicated worker hardware — background jobs compete with API workload on the same VM pool.",
                },
              },
            ],
            costEstimate: {
              min: isHighScale ? 150 : 60,
              max: isHighScale ? 600 : 200,
              assumptions: "Amortized monthly hardware + hypervisor licensing for dedicated worker VM capacity, manually sized for expected background job volume.",
            },
          };
        }
        return {
          serviceName: "Virtual Machines (VMware vSphere / OpenStack Nova) — Manual Scaling",
          alternatives: [
            {
              serviceName: "Bare-Metal Servers",
              reason: "Chose virtualized compute for easier capacity re-allocation between workloads. Bare-metal offers maximum performance with no hypervisor overhead, but has the longest procurement lead time and zero flexibility to reallocate capacity later.",
              costEstimate: {
                min: isHighScale ? 500 : 200,
                max: isHighScale ? 2500 : 700,
                assumptions: "Amortized monthly hardware cost for dedicated bare-metal servers, sized for peak load with no ability to burst.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 400 : 150,
            max: isHighScale ? 2000 : 500,
            assumptions: "Amortized monthly hardware + hypervisor licensing (e.g. VMware vSphere/vCenter) for dedicated VM capacity. No elastic autoscaling — capacity must be pre-provisioned for peak load.",
          },
        };

      case "database":
        return {
          serviceName: "Self-Managed PostgreSQL on Dedicated VM (Manual HA/Failover)",
          alternatives: [
            {
              serviceName: "Licensed Enterprise Database Appliance (e.g. Oracle On-Prem)",
              reason: "Chose open-source PostgreSQL to avoid per-core licensing costs. An enterprise database appliance offers vendor support and turnkey HA tooling at a significant licensing premium.",
              costEstimate: {
                min: isHighScale ? 800 : 300,
                max: isHighScale ? 3000 : 1200,
                assumptions: "Per-core enterprise database licensing plus dedicated hardware — HA/failover tooling included but at a substantial premium.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 300 : 100,
            max: isHighScale ? 1200 : 400,
            assumptions: "Dedicated VM(s) plus storage array allocation. Flag: no managed failover — HA, backups, and patching are fully manual operational responsibilities.",
          },
        };

      case "storage":
        return {
          serviceName: "MinIO on Dedicated Storage Array",
          alternatives: [
            {
              serviceName: "SAN/NAS Object Storage Gateway",
              reason: "Chose MinIO for an S3-compatible API without a proprietary storage vendor lock-in. A SAN/NAS gateway may already exist in your data center and can be repurposed, but usually speaks a narrower protocol set.",
              costEstimate: {
                min: isHighScale ? 300 : 100,
                max: isHighScale ? 1000 : 350,
                assumptions: "Allocated capacity on existing SAN/NAS infrastructure, amortized monthly.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 200 : 80,
            max: isHighScale ? 800 : 300,
            assumptions: "Dedicated storage array capacity + server(s) running MinIO. Backup/replication strategy is a manual operational responsibility.",
          },
        };

      case "queue":
        return {
          serviceName: "RabbitMQ Self-Managed on Dedicated VM",
          alternatives: [
            {
              serviceName: "NATS Self-Managed on Dedicated VM",
              reason: "Chose RabbitMQ for mature tooling. NATS has a lighter footprint but the same fundamental caveat applies either way.",
              costEstimate: {
                min: isHighScale ? 80 : 30,
                max: isHighScale ? 300 : 100,
                assumptions: "Dedicated VM(s) running a self-managed NATS cluster.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 100 : 40,
            max: isHighScale ? 350 : 120,
            assumptions: "Flag: no managed queue available on-premises — RabbitMQ self-managed requires dedicated ops capacity for clustering, HA, and upgrades.",
          },
        };

      case "cache":
        return {
          serviceName: "Redis Self-Managed on Dedicated VM",
          alternatives: [
            {
              serviceName: "Shared Cache Instance (Multi-Tenant)",
              reason: "Chose a dedicated Redis VM for predictable latency and no noisy-neighbor risk. A shared instance is cheaper but risks contention with other workloads.",
              costEstimate: {
                min: isHighScale ? 40 : 15,
                max: isHighScale ? 150 : 50,
                assumptions: "Shared allocation on a multi-tenant cache VM.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 80 : 30,
            max: isHighScale ? 250 : 90,
            assumptions: "Dedicated VM running self-managed Redis. Failover and version upgrades are manual operational responsibilities.",
          },
        };

      case "auth":
        return {
          serviceName: "Keycloak Self-Managed on Dedicated VM",
          alternatives: [
            {
              serviceName: "Integrate with Existing On-Prem Active Directory / LDAP",
              reason: "Chose Keycloak for a modern OIDC-compliant identity layer. If your organization already runs Active Directory/LDAP, federating through it avoids standing up a new identity system entirely.",
              costEstimate: {
                min: 0,
                max: isHighScale ? 60 : 20,
                assumptions: "Incremental integration effort against existing AD/LDAP infrastructure — no new dedicated hardware.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 60 : 25,
            max: isHighScale ? 200 : 70,
            assumptions: "Dedicated VM(s) running Keycloak backed by its own PostgreSQL instance.",
          },
        };

      case "tokenization":
        return {
          serviceName: "HashiCorp Vault Self-Managed (HA Cluster on Dedicated VMs)",
          alternatives: [
            {
              serviceName: "Hardware Security Module (HSM) Appliance",
              reason: "Chose a software Vault HA cluster for lower cost and faster deployment. A dedicated HSM appliance offers stronger, certified key protection guarantees but at a much higher hardware cost and longer procurement time.",
              costEstimate: {
                min: 2000,
                max: 8000,
                assumptions: "Dedicated HSM appliance purchase/lease, amortized monthly — a significant capital expense.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 250 : 100,
            max: isHighScale ? 900 : 350,
            assumptions: "3-node Vault HA cluster on dedicated VMs (Raft storage backend) + a small dedicated tokenization service VM.",
          },
        };

      case "audit-log":
        return {
          serviceName: "Self-Managed SIEM (e.g. Wazuh/ELK Stack) on Dedicated VMs",
          alternatives: [
            {
              serviceName: "Log Files with Manual Archival to WORM Storage",
              reason: "Chose a full SIEM stack for searchable, correlated audit events. Plain log files with manual archival to WORM-capable storage is cheaper but requires building your own retrieval/correlation tooling.",
              costEstimate: {
                min: isHighScale ? 60 : 20,
                max: isHighScale ? 250 : 80,
                assumptions: "WORM-capable storage array allocation for archived log files, no query/correlation tooling included.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 150 : 60,
            max: isHighScale ? 600 : 200,
            assumptions: "Flag: no managed immutable storage on-premises — requires a WORM-capable storage array or write-once tape/archive tier for true audit immutability.",
          },
        };

      case "phi-vault":
        return {
          serviceName: "Encrypted Volume on SAN/NAS with Manual Key Management",
          alternatives: [
            {
              serviceName: "Dedicated HSM Appliance for Key Management",
              reason: "Chose manual key management (encrypted volume + a documented key custody process) to avoid additional hardware spend. A dedicated HSM appliance offers certified, tamper-resistant key storage at a much higher hardware cost.",
              costEstimate: {
                min: 2000,
                max: 8000,
                assumptions: "Dedicated HSM appliance purchase/lease, amortized monthly — a significant capital expense, recommended for real PHI at scale.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 300 : 120,
            max: isHighScale ? 1000 : 400,
            assumptions: "Encrypted SAN/NAS volume allocation for PHI, with a documented manual key-rotation and access-review process — a Business Associate Agreement is still required from any third party involved in hosting or maintaining this hardware.",
          },
        };

      case "deidentification":
        return {
          serviceName: "Microsoft Presidio Self-Hosted on Dedicated VM",
          alternatives: [
            {
              serviceName: "Manual De-identification Review Process",
              reason: "Chose Presidio to automate detection of the 18 HIPAA identifiers. A fully manual review process avoids any new infrastructure but does not scale past small record volumes and is far more error-prone.",
              costEstimate: {
                min: 0,
                max: 0,
                assumptions: "No infrastructure cost — cost shows up as staff time instead, and does not scale.",
              },
            },
          ],
          costEstimate: {
            min: isHighScale ? 100 : 40,
            max: isHighScale ? 350 : 120,
            assumptions: "Dedicated VM running Presidio Analyzer + Anonymizer, invoked by a scheduled batch job.",
          },
        };

      default:
        return {
          serviceName: `Private Cloud Mapped Component (${componentType})`,
          alternatives: [],
          costEstimate: { min: 0, max: 0, assumptions: "Generic on-premises component — no managed-service equivalent assumed." },
        };
    }
  }

  return {
    serviceName: `Cloud Service (${componentType})`,
    alternatives: [],
    costEstimate: { min: 0, max: 0, assumptions: "Fallback." },
  };
}
