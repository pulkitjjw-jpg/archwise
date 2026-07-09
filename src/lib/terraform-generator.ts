export type TerraformFileSet = Record<string, string>;

type IndustryContextForExport = {
  industry: "fintech" | "healthtech" | "none";
  rationale?: string;
  flags?: {
    handlesCardDataDirectly?: boolean;
    storesPHI?: boolean;
    dataResidency?: string;
  };
} | null | undefined;

function buildComplianceSection(industryContext: IndustryContextForExport, components: any[]): string {
  if (!industryContext || industryContext.industry === "none") {
    return "";
  }

  const complianceComponents = components.filter((c) =>
    ["tokenization", "audit-log", "phi-vault", "deidentification"].includes(c.type)
  );
  const componentLines = complianceComponents
    .map((c) => `*   **${c.name}** (\`${c.type}\`): ${c.reasoning || c.description || "Compliance component."}`)
    .join("\n");

  if (industryContext.industry === "fintech") {
    return `
---

> [!IMPORTANT]
> ## Compliance: PCI-DSS

This project was flagged as **fintech** during discovery${industryContext.rationale ? ` (${industryContext.rationale})` : ""}. The following compliance-driven infrastructure was added on top of the baseline architecture:

${componentLines || "*   No dedicated compliance components were added — verify this is expected for your payment flow."}

**What this Terraform does for you:**
*   Provisions an immutable, write-once audit log store for all cardholder-data-adjacent activity (PCI-DSS Requirement 10).
*   Enforces TLS 1.2+ on data stores in the transaction path (PCI-DSS Requirement 4).
${industryContext.flags?.handlesCardDataDirectly ? "*   Provisions a dedicated tokenization layer so raw card data (PAN) never touches application compute or the primary database, shrinking your PCI-DSS scope." : "*   Card data is handled via a third-party processor — this Terraform does not provision cardholder-data storage, but the systems that call the processor are still in scope."}

**What you are still responsible for:**
*   Achieving PCI-DSS certification requires a third-party Qualified Security Assessor (QSA) audit or a completed Self-Assessment Questionnaire (SAQ) — this Terraform is a starting point, not a certification.
*   Network segmentation, firewall rule review, and penetration testing are not automated by this configuration.
*   Key rotation policies, incident response procedures, and employee access reviews must be established operationally.
`;
  }

  // healthtech
  return `
---

> [!IMPORTANT]
> ## Compliance: HIPAA

This project was flagged as **healthtech** during discovery${industryContext.rationale ? ` (${industryContext.rationale})` : ""}. The following compliance-driven infrastructure was added on top of the baseline architecture:

${componentLines || "*   No dedicated compliance components were added — verify this is expected if PHI is involved."}

**What this Terraform does for you:**
*   Provisions an immutable, write-once audit log store recording all access to systems containing PHI (HIPAA Security Rule, 45 CFR 164.312(b)).
*   Enforces TLS 1.2+ on data stores handling regulated data (encryption in transit).
${industryContext.flags?.storesPHI ? "*   Provisions a dedicated, encrypted PHI Data Vault isolated from general application data, with mandatory access logging." : "*   PHI storage was not confirmed during discovery — if patient-identifiable data is added later, re-run generation with that confirmed so a dedicated PHI vault is provisioned."}
${industryContext.flags?.dataResidency && industryContext.flags.dataResidency !== "not_specified" ? `*   Data residency was specified as **${industryContext.flags.dataResidency}** — verify every provisioned region and any managed service's underlying data location honors this before deployment.` : ""}

**What you are still responsible for:**
*   **A signed Business Associate Agreement (BAA) with your cloud provider is required before any real PHI touches this infrastructure.** This Terraform does not and cannot establish that agreement — it is a legal contract between you and the provider.
*   Achieving full HIPAA compliance requires a documented risk assessment, workforce training, and breach notification procedures — this Terraform addresses infrastructure controls only, not administrative or physical safeguards.
*   Verify every managed service used here is on your cloud provider's list of HIPAA-eligible services before deploying real patient data.
`;
}

function buildManualProvisioningSection(provider: string, components: any[]): string {
  if (provider !== "private") return "";

  const rows = components
    .map((c) => {
      const lld = c.cloudMappings?.private?.lld || { config: {}, reasoning: {} };
      const flaggedKey = Object.keys(lld.config).find((k) => k.toLowerCase().includes("flag") || k.toLowerCase().includes("mode") || k.toLowerCase().includes("recommended"));
      const flagNote = flaggedKey ? lld.config[flaggedKey] : "—";
      return `| ${c.name} | ${c.cloudMappings?.private?.serviceName || c.name} | ${flagNote} |`;
    })
    .join("\n");

  return `
---

> [!IMPORTANT]
> ## What Needs Manual Provisioning

Nothing in this Terraform actually provisions private-cloud infrastructure — there is no
generic Terraform provider for "your data center." Every \`null_resource\` in \`compute.tf\` is a
documented placeholder. Being honest about what this tool can and can't automate for you:

**Cannot be automated by this tool at all:**
*   Physical or virtual machine provisioning (pick a real provider in \`main.tf\`: vSphere, OpenStack, or manage bare-metal outside Terraform entirely).
*   Network segmentation / VLAN configuration on your physical switches.
*   Storage array allocation (SAN/NAS) and its own RAID/replication setup.
*   Hardware procurement lead time for anything requiring new physical capacity.

**Explicitly flagged per component (no managed-service equivalent exists on-premises):**

| Component | Chosen Approach | Manual Ops Flag |
|---|---|---|
${rows}

**What you're responsible for that a public cloud would otherwise absorb:**
*   Failover/HA orchestration (no managed multi-AZ equivalent — you configure and test the failover runbook yourself).
*   Patching and version upgrades for every self-managed service (RabbitMQ, PostgreSQL, Redis, etc.).
*   Backup scheduling and restore testing — nothing here schedules or verifies a single backup.
*   Physical security and hardware lifecycle management for whatever data center this deploys into.
`;
}

export function generateTerraformCode(
  provider: "aws" | "azure" | "gcp" | "private",
  projectName: string,
  components: any[],
  connections: any[],
  industryContext?: IndustryContextForExport
): TerraformFileSet {
  const files: TerraformFileSet = {};
  const safeName = projectName.toLowerCase().replace(/[^a-z0-9]/g, "-");

  // Helper to extract lld config & reasoning
  const getLld = (c: any) => {
    return c.cloudMappings?.[provider]?.lld || { config: {}, reasoning: {} };
  };

  const getServiceName = (c: any) => {
    return c.cloudMappings?.[provider]?.serviceName || c.name;
  };

  if (provider === "aws") {
    // ----------------------------------------------------
    // AWS TERRAFORM GENERATOR
    // ----------------------------------------------------

    // VARIABLES.TF
    files["variables.tf"] = `# Terraform Variables for ${projectName}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Target deployment environment (e.g. dev, staging, prod)"
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Primary AWS deployment region"
}

variable "project_name" {
  type        = string
  default     = "${safeName}"
  description = "Unique project identifier prefix"
}
`;

    // NETWORKING.TF
    files["networking.tf"] = `# AWS Networking and VPC Resources

# Rationale: VPC subnets private/public division isolates database and compute nodes from the public web.
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "\${var.project_name}-\${var.environment}-vpc"
    Environment = var.environment
  }
}

resource "aws_subnet" "public_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "\${var.aws_region}a"

  tags = {
    Name = "\${var.project_name}-\${var.environment}-subnet-public-1"
  }
}

resource "aws_subnet" "private_app_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.10.0/24"
  availability_zone = "\${var.aws_region}a"

  tags = {
    Name = "\${var.project_name}-\${var.environment}-subnet-private-app-1"
  }
}

resource "aws_subnet" "private_db_1" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.20.0/24"
  availability_zone = "\${var.aws_region}a"

  tags = {
    Name = "\${var.project_name}-\${var.environment}-subnet-private-db-1"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "\${var.project_name}-\${var.environment}-igw"
  }
}

# NAT Gateway for Compute instances in private app subnets
resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public_1.id

  tags = {
    Name = "\${var.project_name}-\${var.environment}-nat"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public_1" {
  subnet_id      = aws_subnet.public_1.id
  route_table_id = aws_route_table.public.id
}
`;

    // MAIN.TF
    let mainTf = `# Main Provider Configuration for ${projectName}

provider "aws" {
  region = var.aws_region
}
`;

    let computeTf = `# AWS Compute Resources\n\n`;
    let databaseTf = `# AWS Database & Caching Resources\n\n`;
    let storageTf = `# AWS Object Storage Resources\n\n`;
    let outputsTf = `# Terraform Outputs for ${projectName}\n\n`;

    components.forEach((c) => {
      const lld = getLld(c);
      const svc = getServiceName(c);

      // Comments generator helper
      const buildComments = (keys: string[]) => {
        let comments = "";
        keys.forEach((k) => {
          if (lld.config[k] || lld.reasoning[k]) {
            comments += `# LLD config [${k} = ${lld.config[k] || "default"}]: ${lld.reasoning[k] || "Applied rule engine configuration."}\n`;
          }
        });
        return comments;
      };

      if (c.type === "cdn") {
        storageTf += buildComments(["priceClass", "ipv6Enabled", "originShield"]);
        storageTf += `resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = ${lld.config.ipv6Enabled || "true"}
  price_class         = "${lld.config.priceClass || "PriceClass_100"}"

  origin {
    domain_name = "example-origin.s3.amazonaws.com"
    origin_id   = "S3Origin"
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "S3Origin"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name        = "\${var.project_name}-cdn"
    Environment = var.environment
  }
}
\n`;
        outputsTf += `output "cdn_domain_name" {
  value       = aws_cloudfront_distribution.cdn.domain_name
  description = "The CloudFront CDN domain distribution URL."
}
\n`;
      } else if (c.type === "compute") {
        const isWorker = c.id === "worker";
        const hasLambda = svc.includes("Lambda");

        if (hasLambda) {
          computeTf += buildComments(["memory", "timeout", "concurrency"]);
          computeTf += `resource "aws_lambda_function" "${c.id}" {
  filename      = "function.zip"
  function_name = "\${var.project_name}-${c.id}"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  memory_size   = ${parseInt(lld.config.memory || "512", 10)}
  timeout       = ${parseInt(lld.config.timeout || "30", 10)}

  vpc_config {
    subnet_ids         = [aws_subnet.private_app_1.id]
    security_group_ids = [aws_security_group.app_sg.id]
  }

  tags = {
    Name        = "\${var.project_name}-${c.id}"
    Environment = var.environment
  }
}
\n`;
        } else {
          // ECS Fargate
          computeTf += buildComments(["instanceSize", "minInstances", "maxInstances", "scalingPolicy"]);
          computeTf += `resource "aws_ecs_cluster" "${c.id}_cluster" {
  name = "\${var.project_name}-${c.id}-cluster"
}

resource "aws_ecs_task_definition" "${c.id}_task" {
  family                   = "\${var.project_name}-${c.id}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"

  container_definitions = jsonencode([{
    name      = "${c.id}-app"
    image     = "nginx:alpine"
    essential = true
    portMappings = [{
      containerPort = 80
      hostPort      = 80
    }]
  }])
}

resource "aws_ecs_service" "${c.id}_service" {
  name            = "\${var.project_name}-${c.id}-service"
  cluster         = aws_ecs_cluster.${c.id}_cluster.id
  task_definition = aws_ecs_task_definition.${c.id}_task.arn
  desired_count   = ${parseInt(lld.config.minInstances || "1", 10)}
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [aws_subnet.private_app_1.id]
    security_groups = [aws_security_group.app_sg.id]
  }
}
\n`;
        }
      } else if (c.type === "database") {
        const isRds = svc.includes("RDS") || svc.includes("Aurora");

        if (isRds) {
          databaseTf += buildComments(["instanceClass", "storageSize", "multiAZ", "backupRetention"]);
          databaseTf += `resource "aws_db_subnet_group" "db_subnets" {
  name       = "\${var.project_name}-db-subnet-group"
  subnet_ids = [aws_subnet.private_db_1.id, aws_subnet.private_app_1.id] # Multi-AZ Subnets
}

resource "aws_db_instance" "postgres" {
  identifier             = "\${var.project_name}-postgres"
  engine                 = "postgres"
  engine_version         = "15.4"
  instance_class         = "${lld.config.instanceClass || "db.t4g.micro"}"
  allocated_storage      = ${parseInt(lld.config.storageSize || "20", 10)}
  db_subnet_group_name   = aws_db_subnet_group.db_subnets.name
  vpc_security_group_ids = [aws_security_group.db_sg.id]
  multi_az               = ${lld.config.multiAZ === "true" ? "true" : "false"}
  backup_retention_period = ${parseInt(lld.config.backupRetention || "7", 10)}
  skip_final_snapshot    = true
  username               = "dbadmin"
  password               = "ManagedSecretPassword123!"
}
\n`;
          outputsTf += `output "db_endpoint" {
  value       = aws_db_instance.postgres.endpoint
  description = "The database endpoint URL."
}
\n`;
        } else {
          // DynamoDB
          databaseTf += buildComments(["readCapacityUnits", "writeCapacityUnits", "globalTables"]);
          databaseTf += `resource "aws_dynamodb_table" "nosql" {
  name         = "\${var.project_name}-dynamodb"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  tags = {
    Name        = "\${var.project_name}-nosql"
    Environment = var.environment
  }
}
\n`;
        }
      } else if (c.type === "storage") {
        storageTf += buildComments(["lifecycleRule", "versioningEnabled"]);
        storageTf += `resource "aws_s3_bucket" "blobs" {
  bucket = "\${var.project_name}-storage-bucket-unique"

  tags = {
    Name        = "\${var.project_name}-blobs"
    Environment = var.environment
  }
}

resource "aws_s3_bucket_versioning" "blobs" {
  bucket = aws_s3_bucket.blobs.id
  versioning_configuration {
    status = "${lld.config.versioningEnabled === "true" ? "Enabled" : "Disabled"}"
  }
}
\n`;
        outputsTf += `output "s3_bucket_name" {
  value       = aws_s3_bucket.blobs.id
  description = "The unique S3 bucket name."
}
\n`;
      } else if (c.type === "queue") {
        databaseTf += buildComments(["queueType", "visibilityTimeoutSec", "retentionDays"]);
        databaseTf += `resource "aws_sqs_queue" "jobs" {
  name                       = "\${var.project_name}-queue\${var.environment}${lld.config.queueType?.includes("FIFO") ? ".fifo" : ""}"
  fifo_queue                 = ${lld.config.queueType?.includes("FIFO") ? "true" : "false"}
  visibility_timeout_seconds = ${parseInt(lld.config.visibilityTimeoutSec || "900", 10)}
  message_retention_seconds  = 345600 # 4 days
}
\n`;
      } else if (c.type === "cache") {
        databaseTf += buildComments(["nodeType", "clusteringEnabled"]);
        databaseTf += `resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "\${var.project_name}-redis"
  engine               = "redis"
  node_type            = "${lld.config.nodeType || "cache.t4g.micro"}"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_db_subnet_group.db_subnets.name
}
\n`;
      } else if (c.type === "auth") {
        databaseTf += buildComments(["mfaRequired"]);
        databaseTf += `resource "aws_cognito_user_pool" "pool" {
  name = "\${var.project_name}-user-pool"

  password_policy {
    minimum_length = 8
    require_lowercase = true
    require_numbers = true
    require_symbols = true
    require_uppercase = true
  }

  mfa_configuration = "${lld.config.mfaRequired === "true" ? "ON" : "OFF"}"
}
\n`;
      }
    });

    // Add Security groups and IAM placeholders in compute.tf
    computeTf += `# Security Groups and IAM Roles for Compute Nodes

resource "aws_security_group" "app_sg" {
  name        = "\${var.project_name}-\${var.environment}-app-sg"
  description = "Allows inbound traffic to application servers"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db_sg" {
  name   = "\${var.project_name}-\${var.environment}-db-sg"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "lambda_exec" {
  name = "\${var.project_name}-lambda-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Rationale: IAM permissions bound to compute role, granting read/write strictly to storage buckets.
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}
`;

    files["main.tf"] = mainTf;
    files["compute.tf"] = computeTf;
    files["database.tf"] = databaseTf;
    files["storage.tf"] = storageTf;
    files["outputs.tf"] = outputsTf;

  } else if (provider === "azure") {
    // ----------------------------------------------------
    // AZURE TERRAFORM GENERATOR
    // ----------------------------------------------------

    files["variables.tf"] = `# Azure Variables for ${projectName}

variable "environment" {
  type    = string
  default = "dev"
}

variable "location" {
  type    = string
  default = "East US"
}

variable "project_name" {
  type    = string
  default = "${safeName}"
}
`;

    files["networking.tf"] = `# Azure Virtual Network Resources

resource "azurerm_resource_group" "rg" {
  name     = "\${var.project_name}-\${var.environment}-rg"
  location = var.location
}

# Rationale: Subnets split ensures database nodes are isolated from front-facing container app APIs.
resource "azurerm_virtual_network" "vnet" {
  name                = "\${var.project_name}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "app_subnet" {
  name                 = "app-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_subnet" "db_subnet" {
  name                 = "db-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.2.0/24"]
}
`;

    let mainTf = `# Main Provider Configuration for ${projectName}

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}
`;

    let computeTf = `# Azure Compute Resources\n\n`;
    let databaseTf = `# Azure Database Resources\n\n`;
    let storageTf = `# Azure Storage & CDN Resources\n\n`;
    let outputsTf = `# Azure Outputs for ${projectName}\n\n`;

    components.forEach((c) => {
      const lld = getLld(c);
      const svc = getServiceName(c);

      const buildComments = (keys: string[]) => {
        let comments = "";
        keys.forEach((k) => {
          if (lld.config[k] || lld.reasoning[k]) {
            comments += `# LLD config [${k} = ${lld.config[k] || "default"}]: ${lld.reasoning[k] || "Applied rule engine configuration."}\n`;
          }
        });
        return comments;
      };

      if (c.type === "cdn") {
        storageTf += buildComments(["priceClass"]);
        storageTf += `resource "azurerm_frontdoor_profile" "cdn" {
  name                = "\${var.project_name}-frontdoor"
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard_AzureFrontDoor"
}
\n`;
      } else if (c.type === "compute") {
        const hasFunctions = svc.includes("Functions");

        if (hasFunctions) {
          computeTf += buildComments(["memory", "timeout", "concurrency"]);
          computeTf += `resource "azurerm_service_plan" "func_plan" {
  name                = "\${var.project_name}-functions-plan"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  os_type             = "Linux"
  sku_name            = "Y1" # Consumption Serverless
}

resource "azurerm_linux_function_app" "${c.id}" {
  name                = "\${var.project_name}-${c.id}-app"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  service_plan_id     = azurerm_service_plan.func_plan.id
  storage_account_name       = azurerm_storage_account.storage.name
  storage_account_access_key = azurerm_storage_account.storage.primary_access_key

  site_config {
    application_stack {
      node_version = "18"
    }
  }
}
\n`;
        } else {
          // Container Apps
          computeTf += buildComments(["instanceSize", "minInstances", "maxInstances"]);
          computeTf += `resource "azurerm_container_app_environment" "env" {
  name                = "\${var.project_name}-containerapp-env"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
}

resource "azurerm_container_app" "${c.id}" {
  name                         = "\${var.project_name}-${c.id}"
  container_app_environment_id = azurerm_container_app_environment.env.id
  resource_group_name          = azurerm_resource_group.rg.name
  revision_mode                = "Single"

  template {
    container {
      name   = "web"
      image  = "nginx:alpine"
      cpu    = 0.25
      memory = "0.5Gi"
    }
    min_replicas = ${parseInt(lld.config.minInstances || "1", 10)}
    max_replicas = ${parseInt(lld.config.maxInstances || "3", 10)}
  }
}
\n`;
        }
      } else if (c.type === "database") {
        const isPg = svc.includes("PostgreSQL");

        if (isPg) {
          databaseTf += buildComments(["instanceClass", "storageSize", "backupRetention", "multiAZ"]);
          databaseTf += `resource "azurerm_postgresql_flexible_server" "db" {
  name                = "\${var.project_name}-pg-db"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  version             = "14"
  administrator_login          = "psqladmin"
  administrator_password       = "ManagedSecretPassword123!"
  sku_name                     = "${lld.config.instanceClass || "MO_Standard_E2ds_v4"}"
  storage_mb                   = ${parseInt(lld.config.storageSize || "32", 10) * 1024}
  backup_retention_days        = ${parseInt(lld.config.backupRetention || "7", 10)}
}
\n`;
          outputsTf += `output "db_fqdn" {
  value       = azurerm_postgresql_flexible_server.db.fqdn
  description = "The fully qualified database endpoint."
}
\n`;
        } else {
          // Cosmos DB NoSQL
          databaseTf += buildComments(["readCapacityUnits"]);
          databaseTf += `resource "azurerm_cosmosdb_account" "cosmos" {
  name                = "\${var.project_name}-cosmos"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = azurerm_resource_group.rg.location
    failover_priority = 0
  }
}
\n`;
        }
      } else if (c.type === "storage" || svc.includes("Storage")) {
        storageTf += buildComments(["lifecycleRule", "versioningEnabled"]);
        storageTf += `resource "azurerm_storage_account" "storage" {
  name                     = "\${var.project_name}storeunique"
  resource_group_name      = azurerm_resource_group.rg.name
  location                 = azurerm_resource_group.rg.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_container" "blobs" {
  name                  = "media"
  storage_account_name  = azurerm_storage_account.storage.name
  container_access_type = "private"
}
\n`;
      } else if (c.type === "queue") {
        databaseTf += buildComments(["queueType", "visibilityTimeoutSec"]);
        databaseTf += `resource "azurerm_servicebus_namespace" "sb" {
  name                = "\${var.project_name}-sb"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "jobs" {
  name         = "task-queue"
  namespace_id = azurerm_servicebus_namespace.sb.id
}
\n`;
      } else if (c.type === "cache") {
        databaseTf += buildComments(["nodeType"]);
        databaseTf += `resource "azurerm_redis_cache" "redis" {
  name                = "\${var.project_name}-redis"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  capacity            = 0
  family              = "C"
  sku_name            = "Basic"
}
\n`;
      }
    });

    files["main.tf"] = mainTf;
    files["compute.tf"] = computeTf;
    files["database.tf"] = databaseTf;
    files["storage.tf"] = storageTf;
    files["outputs.tf"] = outputsTf;

  } else if (provider === "gcp") {
    // ----------------------------------------------------
    // GCP TERRAFORM GENERATOR
    // ----------------------------------------------------

    files["variables.tf"] = `# Google Cloud Variables for ${projectName}

variable "environment" {
  type    = string
  default = "dev"
}

variable "gcp_project" {
  type        = string
  default     = "${safeName}"
  description = "Google Cloud Project ID"
}

variable "gcp_region" {
  type    = string
  default = "us-central1"
}
`;

    files["networking.tf"] = `# Google VPC Networking Resources

# Rationale: VPC networks separate internal application routing from entryload balancers.
resource "google_compute_network" "vpc" {
  name                    = "\${var.gcp_project}-\${var.environment}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "subnet-us-central"
  ip_cidr_range = "10.0.1.0/24"
  region        = var.gcp_region
  network       = google_compute_network.vpc.id
}
`;

    let mainTf = `# Main Provider Configuration for ${projectName}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}
`;

    let computeTf = `# Google Cloud Compute Resources\n\n`;
    let databaseTf = `# Google Cloud Database Resources\n\n`;
    let storageTf = `# Google Cloud Storage & CDN Resources\n\n`;
    let outputsTf = `# Google Cloud Outputs for ${projectName}\n\n`;

    components.forEach((c) => {
      const lld = getLld(c);
      const svc = getServiceName(c);

      const buildComments = (keys: string[]) => {
        let comments = "";
        keys.forEach((k) => {
          if (lld.config[k] || lld.reasoning[k]) {
            comments += `# LLD config [${k} = ${lld.config[k] || "default"}]: ${lld.reasoning[k] || "Applied rule engine configuration."}\n`;
          }
        });
        return comments;
      };

      if (c.type === "cdn") {
        storageTf += `resource "google_compute_backend_bucket" "cdn" {
  name        = "\${var.gcp_project}-cdn"
  bucket_name = google_storage_bucket.storage.name
  enable_cdn  = true
}
\n`;
      } else if (c.type === "compute") {
        const hasFunctions = svc.includes("Functions");

        if (hasFunctions) {
          computeTf += buildComments(["memory", "timeout", "concurrency"]);
          computeTf += `resource "google_cloudfunctions_function" "${c.id}" {
  name        = "\${var.gcp_project}-${c.id}"
  description = "Google Cloud Function endpoint for ${c.id}"
  runtime     = "nodejs20"

  available_memory_mb   = ${parseInt(lld.config.memory || "512", 10)}
  timeout               = ${parseInt(lld.config.timeout || "30", 10)}
  entry_point           = "handler"
  trigger_http          = true
}
\n`;
        } else {
          // Cloud Run
          computeTf += buildComments(["instanceSize", "minInstances", "maxInstances"]);
          computeTf += `resource "google_cloud_run_service" "${c.id}" {
  name     = "\${var.gcp_project}-${c.id}"
  location = var.gcp_region

  template {
    spec {
      containers {
        image = "gcr.io/cloudrun/hello"
        resources {
          limits = {
            memory = "512Mi"
            cpu    = "1000m"
          }
        }
      }
    }
    metadata {
      annotations = {
        "autoscaling.knative.dev/minScale" = "${lld.config.minInstances || "1"}"
        "autoscaling.knative.dev/maxScale" = "${lld.config.maxInstances || "3"}"
      }
    }
  }
}
\n`;
        }
      } else if (c.type === "database") {
        const isPg = svc.includes("PostgreSQL");

        if (isPg) {
          databaseTf += buildComments(["instanceClass", "storageSize", "backupRetention", "multiAZ"]);
          databaseTf += `resource "google_sql_database_instance" "db" {
  name             = "\${var.gcp_project}-postgres-db"
  region           = var.gcp_region
  database_version = "POSTGRES_15"

  settings {
    tier = "${lld.config.instanceClass || "db-f1-micro"}"
    disk_size = ${parseInt(lld.config.storageSize || "20", 10)}
    disk_type = "PD_SSD"
    availability_type = "${lld.config.multiAZ === "true" ? "REGIONAL" : "ZONAL"}"

    backup_configuration {
      enabled    = true
      start_time = "02:00"
    }
  }
}
\n`;
          outputsTf += `output "db_ip" {
  value       = google_sql_database_instance.db.public_ip_address
  description = "The database instance public IP."
}
\n`;
        } else {
          // Firestore NoSQL
          databaseTf += buildComments(["readCapacityUnits"]);
          databaseTf += `resource "google_firestore_database" "nosql" {
  name        = "(default)"
  project     = var.gcp_project
  type        = "FIRESTORE_NATIVE"
  location_id = "us-east1"
}
\n`;
        }
      } else if (c.type === "storage" || svc.includes("Storage")) {
        storageTf += buildComments(["lifecycleRule", "versioningEnabled"]);
        storageTf += `resource "google_storage_bucket" "storage" {
  name          = "\${var.gcp_project}-bucket-storage-unique"
  location      = var.gcp_region
  force_destroy = true

  versioning {
    enabled = ${lld.config.versioningEnabled === "true" ? "true" : "false"}
  }
}
\n`;
      } else if (c.type === "queue") {
        databaseTf += buildComments(["queueType"]);
        databaseTf += `resource "google_pubsub_topic" "pubsub" {
  name = "\${var.gcp_project}-jobs-topic"
}

resource "google_pubsub_subscription" "jobs_sub" {
  name  = "task-queue-sub"
  topic = google_pubsub_topic.pubsub.name
}
\n`;
      } else if (c.type === "cache") {
        databaseTf += buildComments(["nodeType"]);
        databaseTf += `resource "google_redis_instance" "redis" {
  name           = "\${var.gcp_project}-cache"
  tier           = "BASIC"
  memory_size_gb = 1
  region         = var.gcp_region
}
\n`;
      }
    });

    files["main.tf"] = mainTf;
    files["compute.tf"] = computeTf;
    files["database.tf"] = databaseTf;
    files["storage.tf"] = storageTf;
    files["outputs.tf"] = outputsTf;
  } else if (provider === "private") {
    // ----------------------------------------------------
    // PRIVATE CLOUD / ON-PREMISES TERRAFORM GENERATOR
    // ----------------------------------------------------
    // No single Terraform provider covers "private cloud" — VMware, OpenStack, and bare-metal
    // all need different providers with environment-specific credentials this tool can't know.
    // Rather than guess, this generates null_resource placeholders that document exactly what
    // needs manual provisioning per component, plus commented-out real provider blocks for the
    // two most common private-cloud Terraform providers so you have a starting point either way.

    files["variables.tf"] = `# Private Cloud Variables for ${projectName}

variable "environment" {
  type    = string
  default = "dev"
}

variable "project_name" {
  type    = string
  default = "${safeName}"
}

# Fill in once you've picked a private cloud provider (see main.tf for options).
variable "datacenter_name" {
  type        = string
  default     = ""
  description = "vSphere datacenter / OpenStack region / physical site identifier."
}
`;

    files["main.tf"] = `# Provider Configuration for ${projectName} — PRIVATE CLOUD
#
# Uncomment and configure ONE of the following depending on your actual private cloud platform.
# This tool cannot auto-detect or provision credentials for on-premises infrastructure.

# --- Option A: VMware vSphere ---
# terraform {
#   required_providers {
#     vsphere = {
#       source  = "hashicorp/vsphere"
#       version = "~> 2.0"
#     }
#   }
# }
# provider "vsphere" {
#   user           = var.vsphere_user
#   password       = var.vsphere_password
#   vsphere_server = var.vsphere_server
# }

# --- Option B: OpenStack ---
# terraform {
#   required_providers {
#     openstack = {
#       source  = "terraform-provider-openstack/openstack"
#       version = "~> 1.53"
#     }
#   }
# }
# provider "openstack" {
#   cloud = "my-openstack-cloud"
# }

# --- Option C: Bare-metal (no provider — infrastructure provisioned outside Terraform) ---
# If deploying to bare metal without a virtualization layer, most of what's below is
# configuration management (Ansible/Puppet/manual) rather than Terraform's job.
`;

    let manualProvisioningTf = `# Private Cloud Resource Placeholders for ${projectName}
#
# These null_resource blocks are NOT real infrastructure — Terraform has no generic way to
# provision a VM on an arbitrary private cloud. Each one documents exactly what a human (or a
# platform-specific Terraform provider, once you pick one above) needs to provision manually.

`;

    components.forEach((c) => {
      const lld = getLld(c);
      const svc = getServiceName(c);
      manualProvisioningTf += `# ---- ${c.name} → ${svc} ----
${Object.keys(lld.config || {})
  .map((k) => `# ${k}: ${lld.config[k]}${lld.reasoning?.[k] ? ` — ${lld.reasoning[k]}` : ""}`)
  .join("\n")}
resource "null_resource" "${c.id}_manual_provisioning" {
  triggers = {
    component   = "${c.id}"
    service     = "${svc.replace(/"/g, "'")}"
    provisioned = "false" # flip once this component has actually been provisioned by hand
  }
}

`;
    });

    files["compute.tf"] = manualProvisioningTf;
    files["outputs.tf"] = `# No computed outputs — private cloud resources above are manual placeholders,
# not real Terraform-managed infrastructure. Update this once real resources exist.
`;
  }

  // README.MD (Consistent across providers)
  files["README.md"] = `# Terraform Configurations for ${projectName}

This Terraform configuration script was automatically synthesized by the **AI Cloud Architecture Generator** based on your project requirements and low-level designs.

## File Structure
*   \`main.tf\`: Provider registrations and base authentication parameters.
*   \`networking.tf\`: Private subnets, VPC network definitions, and firewall wrappers.
*   \`compute.tf\`: API servers, application workers, and execution limits.
*   \`database.tf\`: Database persistence layers and caching clusters.
*   \`storage.tf\`: Object storage buckets and asset delivery CDNs.
*   \`variables.tf\`: Parameter definitions (regions, environments, naming prefixes).
*   \`outputs.tf\`: Primary outputs (endpoints, database hosts, resource names).

---

> [!WARNING]
> ## Deployment Security Disclaimer
> This configuration represents a starting point. It has been derived automatically based on design rules and client brainstorming.
> You MUST review instance profiles, security group configurations, IAM roles, and pricing implications before running \`terraform apply\` in any real staging or production environments.
${buildComplianceSection(industryContext, components)}
${buildManualProvisioningSection(provider, components)}
---

## State Management Configuration
To maintain shared and remote state files, configure a backend configuration block inside \`main.tf\`. 

### Remote State Backend Templates

#### AWS S3 Backend:
\`\`\`hcl
terraform {
  backend "s3" {
    bucket         = "your-terraform-state-bucket"
    key            = "states/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terraform-lock"
  }
}
\`\`\`

#### Azure Blob Backend:
\`\`\`hcl
terraform {
  backend "azurerm" {
    resource_group_name  = "state-resource-group"
    storage_account_name = "statestorageaccount"
    container_name       = "tfstate"
    key                  = "terraform.tfstate"
  }
}
\`\`\`

#### GCP Cloud Storage Backend:
\`\`\`hcl
terraform {
  backend "gcs" {
    bucket  = "your-terraform-state-bucket"
    prefix  = "terraform/state"
  }
}
\`\`\`

---

## Deployment Steps
1. Install the Terraform CLI on your workstation.
2. Authenticate CLI access with credentials (e.g. \`aws configure\`, \`az login\`, or \`gcloud auth\`).
3. Run initialization:
   \`\`\`bash
   terraform init
   \`\`\`
4. Preview the changes:
   \`\`\`bash
   terraform plan
   \`\`\`
5. Apply changes:
   \`\`\`bash
   terraform apply
   \`\`\`
`;

  return files;
}
