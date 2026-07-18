from app.services.nfr_signals import is_budget_tight


def _connection(from_: str, to: str, protocol: str | None = None) -> dict:
    conn: dict = {"from": from_, "to": to}
    if protocol is not None:
        conn["protocol"] = protocol
    return conn


def is_relational_data_nature(requirements: dict) -> bool:
    """Shared with cloud_mapping.py so the abstract component's label ("Relational Database"
    vs. "Document Database") and the cloud service actually selected for it never disagree --
    both must derive the relational-vs-NoSQL decision from the exact same signal."""
    data_lower = requirements["nonFunctional"]["dataNature"].lower()
    func_str = " ".join(requirements["functional"]).lower()
    return (
        "relational" in data_lower
        or "transaction" in data_lower
        or "invoice" in data_lower
        or "sql" in data_lower
        or "invoice" in func_str
        or "transaction" in func_str
    )


def run_rules_engine(requirements: dict) -> dict:
    components: list[dict] = []
    connections: list[dict] = []
    rules_trace: list[str] = []

    nfr = requirements["nonFunctional"]
    func_str = " ".join(requirements["functional"]).lower()

    # 1. Content Delivery Network (CDN)
    needs_cdn = (
        "high" in nfr["latencySensitivity"].lower()
        or "high" in nfr["expectedScale"].lower()
        or "image" in func_str
        or "file" in func_str
        or "media" in func_str
        or "picture" in func_str
        or "video" in func_str
        or "pdf" in func_str
    )

    if needs_cdn:
        components.append(
            {
                "id": "cdn",
                "name": "Content Delivery Network",
                "type": "cdn",
                "description": "Distributes static assets and uploads, offloading pressure from primary API servers.",
                "rulesFired": [
                    "Rule-CDN-HighScale-Or-Media: Latency sensitivity is high or workload includes media uploads."
                ],
                "reasoning": "Suggested by CDN rule based on latency or media requirements.",
            }
        )
        rules_trace.append("Rule-CDN-HighScale-Or-Media")

    # 2. Compute (Serverless vs Containers)
    budget_tight = is_budget_tight(nfr["budget"])

    team_lower = nfr["teamMaturity"].lower()
    is_team_junior = (
        "junior" in team_lower or "small" in team_lower or team_lower == "not_specified"
    )

    if budget_tight and is_team_junior:
        components.append(
            {
                "id": "compute",
                "name": "Managed Serverless Compute",
                "type": "compute",
                "description": "Executes API and business logic on-demand without managing server instances, minimizing costs.",
                "rulesFired": [
                    "Rule-Compute-Serverless: Tight budget and small team maturity trigger serverless architecture."
                ],
                "reasoning": "Suggested by Serverless Compute rule for low cost and minimal operations overhead.",
            }
        )
        rules_trace.append("Rule-Compute-Serverless")
    else:
        components.append(
            {
                "id": "compute",
                "name": "API Container Service",
                "type": "compute",
                "description": "Runs API containers in a managed orchestration cluster for consistent execution and long-running requests.",
                "rulesFired": [
                    "Rule-Compute-Container: Higher team maturity or budget accommodates container-based microservices."
                ],
                "reasoning": "Suggested by Container Compute rule for stable request execution.",
            }
        )
        rules_trace.append("Rule-Compute-Container")

        # Container-style compute has no ingress path of its own -- unlike serverless (whose
        # own managed gateway is resolved per-provider inside cloud_mapping.py's "lb" branch,
        # not a separate HLD component), a fleet of container instances needs an explicit,
        # first-class routing/edge component in front of it. This is also where TLS termination
        # and health checks live in every real reference architecture, so it earns its own box
        # with its own reasoning/cost/LLD rather than staying invisibly bundled into compute's
        # own service name.
        components.append(
            {
                "id": "lb",
                "name": "Load Balancer",
                "type": "lb",
                "description": "Distributes incoming traffic across compute instances and is the system's single public entry point.",
                "rulesFired": [
                    "Rule-LB-Container: Container-based compute needs an explicit ingress/routing layer in front of it."
                ],
                "reasoning": "Routes and load-balances incoming requests across compute instances, terminates TLS, and performs health checks so unhealthy instances are automatically taken out of rotation.",
            }
        )
        rules_trace.append("Rule-LB-Container")
        connections.append(_connection("lb", "compute", "HTTPS"))

    needs_lb = "lb" in {c["id"] for c in components}

    if needs_cdn:
        # The CDN sits in front of whatever is actually public-facing: the load balancer when
        # one exists (the more architecturally correct request path -- CDN edge caches static
        # content, then hands dynamic requests down to the LB, not straight to compute), or
        # compute directly for serverless architectures that have no separate lb component.
        connections.append(_connection("cdn", "lb", "HTTPS") if needs_lb else _connection("cdn", "compute", "HTTPS"))

    # 2b. Managed DNS -- whenever there's a real public-facing edge (an lb or a cdn), a managed
    # DNS layer is what actually routes a custom domain to it. Kept intentionally light for now
    # (routing policy defaults to "Simple" in cloud_mapping.py/lld_rules.py) -- this is also the
    # mechanism a future multi-region failover phase would route through, but that capability
    # doesn't exist yet and this component doesn't claim it does.
    if needs_lb or needs_cdn:
        components.append(
            {
                "id": "dns",
                "name": "Managed DNS",
                "type": "dns",
                "description": "Resolves the product's custom domain to its public-facing entry point.",
                "rulesFired": [
                    "Rule-DNS-PublicEdge: A public-facing load balancer or CDN exists, so a managed DNS layer is needed to route a custom domain to it."
                ],
                "reasoning": (
                    "Routes the product's custom domain to its public edge. Also the mechanism a future "
                    "multi-region failover setup would route through -- not configured for that yet, but "
                    "this is where that capability would be added."
                ),
            }
        )
        rules_trace.append("Rule-DNS-PublicEdge")
        connections.append(_connection("dns", "lb", "DNS") if needs_lb else _connection("dns", "cdn", "DNS"))

    # 3. Storage & Database
    is_relational = is_relational_data_nature(requirements)

    if is_relational:
        components.append(
            {
                "id": "database",
                "name": "Relational Database",
                "type": "database",
                "description": "Stores transactional records with strict ACID consistency.",
                "rulesFired": [
                    "Rule-DB-Relational: Relational or transactional data characteristics mandate ACID properties."
                ],
                "reasoning": "Suggested by Relational Database rule to preserve structural data consistency.",
            }
        )
        rules_trace.append("Rule-DB-Relational")
    else:
        components.append(
            {
                "id": "database",
                "name": "Document Database",
                "type": "database",
                "description": "A flexible document store for unstructured schema-less data.",
                "rulesFired": [
                    "Rule-DB-Document: Unstructured or key-value data characteristics map to NoSQL document store."
                ],
                "reasoning": "Suggested by Document Database rule for schema flexibility.",
            }
        )
        rules_trace.append("Rule-DB-Document")
    connections.append(_connection("compute", "database", "SQL/TCP"))

    # 4. Object Storage (if upload media)
    data_lower = nfr["dataNature"].lower()
    needs_object_store = (
        "media" in data_lower
        or "file" in data_lower
        or "pdf" in data_lower
        or "upload" in func_str
        or "file" in func_str
        or "picture" in func_str
        or "pdf" in func_str
    )

    if needs_object_store:
        components.append(
            {
                "id": "storage",
                "name": "Object Storage Bucket",
                "type": "storage",
                "description": "Stores unstructured media uploads, invoices, and static blobs durably and cheaply.",
                "rulesFired": ["Rule-Storage-Object: System requires file/media storage capacity."],
                "reasoning": "Suggested by Object Storage rule for file/media persistence.",
            }
        )
        rules_trace.append("Rule-Storage-Object")
        connections.append(_connection("compute", "storage", "HTTPS"))
        if needs_cdn:
            connections.append(_connection("cdn", "storage", "HTTPS"))

    # 5. Caching
    read_write_lower = nfr["readWritePattern"].lower()
    needs_cache = (
        "read-heavy" in read_write_lower
        or "cache" in read_write_lower
        or "high" in nfr["expectedScale"].lower()
    )

    if needs_cache:
        components.append(
            {
                "id": "cache",
                "name": "In-Memory Cache",
                "type": "cache",
                "description": "Speeds up read accesses for repetitive database queries and active sessions.",
                "rulesFired": [
                    "Rule-Cache-ReadHeavy: Read-heavy pattern or high expected scale warrants caching layer."
                ],
                "reasoning": "Suggested by In-Memory Cache rule to buffer database read load.",
            }
        )
        rules_trace.append("Rule-Cache-ReadHeavy")
        connections.append(_connection("compute", "cache", "Redis/TCP"))

    # 6. Queue & Worker
    needs_queue = (
        "async" in read_write_lower
        or "background" in func_str
        or "queue" in func_str
        or "async" in func_str
        or "worker" in func_str
        or "upload" in func_str  # files are typically processed asynchronously
    )

    if needs_queue:
        components.append(
            {
                "id": "queue",
                "name": "Message Queue",
                "type": "queue",
                "description": "Buffers spikes in incoming events/tasks and decouples asynchronous background tasks.",
                "rulesFired": [
                    "Rule-Queue-Async: Asynchronous requirements or background jobs request event buffering."
                ],
                "reasoning": "Suggested by Message Queue rule to decouple request handling.",
            }
        )
        components.append(
            {
                "id": "worker",
                "name": "Background Compute Worker",
                "type": "compute",
                "description": "Processes queued background tasks, such as generating PDF reports or resizing uploads.",
                "rulesFired": [
                    "Rule-Worker-Async: Decoupled workers execute background jobs asynchronously."
                ],
                "reasoning": "Suggested by Background Compute Worker rule to execute async workloads.",
            }
        )
        rules_trace.append("Rule-Queue-Worker")

        connections.append(_connection("compute", "queue", "AMQP/HTTP"))
        connections.append(_connection("queue", "worker", "Poll"))
        connections.append(_connection("worker", "database", "SQL/TCP"))
        if needs_object_store:
            connections.append(_connection("worker", "storage", "HTTPS"))

    # 7. Security / Authentication component if compliance specifies audit/encryption/GDPR
    compliance_lower = nfr["compliance"].lower()
    needs_auth = (
        "gdpr" in compliance_lower
        or "encrypt" in compliance_lower
        or "security" in compliance_lower
        or "auth" in compliance_lower
        or "auth" in func_str
        or "login" in func_str
        or "signin" in func_str
    )

    if needs_auth:
        components.append(
            {
                "id": "auth",
                "name": "Authentication & Identity Provider",
                "type": "auth",
                "description": "Handles user sessions, token issuance, encryption logs, and access control lists.",
                "rulesFired": [
                    "Rule-Auth-Compliance: Security requirements or login actions require user authentication."
                ],
                "reasoning": "Suggested by Authentication rule to enforce data security controls.",
            }
        )
        rules_trace.append("Rule-Auth-Compliance")
        connections.append(_connection("compute", "auth", "OIDC/HTTPS"))

    return {"components": components, "connections": connections, "rulesTrace": rules_trace}
