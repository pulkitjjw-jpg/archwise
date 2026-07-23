"""HTTP-level tests for POST /projects/{id}/architectures/security-fix (the "Fix this" quick
action on a security finding -- see security_rules.py's FIX_HANDLERS docstring for the exact
scope: a known-safe LLD config patch for a subset of findings, never a structural add-component/
rewire-connections change).
"""

import uuid

import pytest

from app.models import Architecture, Requirement

pytestmark = pytest.mark.asyncio


async def _make_requirement(db_session, project, *, non_functional=None, industry_context=None):
    req = Requirement(
        project_id=project.id,
        functional=["Users can log in and view their data"],
        non_functional=non_functional
        or {
            "budget": "$5,000/month",
            "compliance": "none",
            "teamMaturity": "small team",
            "expectedScale": "1,000 users",
        },
        industry_context=industry_context or {"industry": "none", "flags": {}, "rationale": "", "complianceAnswers": []},
    )
    db_session.add(req)
    await db_session.commit()
    await db_session.refresh(req)
    return req


async def _make_architecture(db_session, project, components, connections=None, version="0.1.0"):
    arch = Architecture(
        project_id=project.id,
        version=version,
        hld={"components": components, "connections": connections or []},
        reasoning={"decisions": [], "assumptions": [], "risks": [], "recommendation": None, "diff": None},
        security_findings={},
    )
    db_session.add(arch)
    await db_session.commit()
    await db_session.refresh(arch)
    return arch


def _database_component(config: dict | None = None):
    return {
        "id": "database",
        "name": "Relational Database",
        "type": "database",
        "description": "",
        "reasoning": "",
        "cloudMappings": {
            "aws": {
                "serviceName": "Amazon RDS",
                "alternatives": [],
                "costEstimate": {"min": 10, "max": 20},
                "lld": {"config": config or {}, "reasoning": {}},
            }
        },
    }


def _auth_component(config: dict | None = None):
    return {
        "id": "auth",
        "name": "Authentication & Identity Provider",
        "type": "auth",
        "description": "",
        "reasoning": "",
        "cloudMappings": {
            "aws": {
                "serviceName": "Amazon Cognito",
                "alternatives": [],
                "costEstimate": {"min": 5, "max": 10},
                "lld": {"config": config or {}, "reasoning": {}},
            }
        },
    }


def _lb_component(config: dict | None = None):
    return {
        "id": "lb",
        "name": "Load Balancer",
        "type": "lb",
        "description": "",
        "reasoning": "",
        "cloudMappings": {
            "aws": {
                "serviceName": "Application Load Balancer",
                "alternatives": [],
                "costEstimate": {"min": 15, "max": 25},
                "lld": {"config": config or {}, "reasoning": {}},
            }
        },
    }


def _dns_component(config: dict | None = None):
    return {
        "id": "dns",
        "name": "Managed DNS",
        "type": "dns",
        "description": "",
        "reasoning": "",
        "cloudMappings": {
            "aws": {
                "serviceName": "Amazon Route 53",
                "alternatives": [],
                "costEstimate": {"min": 1, "max": 2},
                "lld": {"config": config or {}, "reasoning": {}},
            }
        },
    }


async def test_fixes_database_encryption(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component()])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "Database has no explicit encryption configuration recorded",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    new_components = resp.json()["architecture"]["hld"]["components"]
    fixed = next(c for c in new_components if c["id"] == "database")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["encryptionInTransit"] == "TLS 1.2+ (Enforced)"
    # The finding is gone from the recomputed set for this provider.
    findings = resp.json()["architecture"]["securityFindings"]["aws"]
    assert not any(f["title"] == "Database has no explicit encryption configuration recorded" for f in findings)


async def test_fixes_mfa_required(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_auth_component({"mfaRequired": "false"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={"componentId": "auth", "findingTitle": "Multi-factor authentication is not required", "provider": "aws"},
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "auth")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["mfaRequired"] == "true"


async def test_fixes_self_sign_up(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_auth_component({"selfSignUpEnabled": "true"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "auth",
            "findingTitle": "Unrestricted self-service sign-up on a sensitive-data system",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "auth")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["selfSignUpEnabled"] == "false"


@pytest.mark.parametrize(
    ("provider", "expected_rule_set"),
    [
        ("aws", "AWS Managed Rules - Core Rule Set + SQL Injection Rule Set"),
        ("azure", "Azure-managed Default Rule Set (DRS)"),
        ("gcp", "Google Cloud Armor - OWASP Top 10 preconfigured rules"),
    ],
)
async def test_fixes_waf_per_provider(as_user, make_user, make_project, db_session, provider, expected_rule_set):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    lb = _lb_component({"wafEnabled": "false"})
    lb["cloudMappings"][provider] = lb["cloudMappings"].pop("aws")
    await _make_architecture(db_session, project, [lb])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "lb",
            "findingTitle": "Public-facing edge has no WAF despite handling sensitive data",
            "provider": provider,
        },
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "lb")
    config = fixed["cloudMappings"][provider]["lld"]["config"]
    assert config["wafEnabled"] == "true"
    assert config["wafRuleSet"] == expected_rule_set


async def test_fixes_multi_az(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component({"multiAZ": "false"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={"componentId": "database", "findingTitle": "Database has no automatic failover configured", "provider": "aws"},
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "database")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["multiAZ"] == "true (Primary/Standby)"


async def test_fixes_backup_retention(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component({"backupRetention": "0"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "Database backup retention is effectively disabled",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "database")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["backupRetention"] == "30 Days"


@pytest.mark.parametrize(
    ("compliance", "expected_scale", "expected_strategy"),
    [
        # Explicit business-continuity phrase alone triggers warm-standby directly (determine_dr_
        # strategy's explicit_signal path), regardless of scale.
        ("99.99% availability required, cannot afford downtime", "1,000 users", "warm-standby"),
        # High scale ALONE (no explicit phrase, no regulated industry/compliance signal) is only
        # ONE of the two compounding signals -- pilot-light, not warm-standby.
        ("none", "50,000 users", "pilot-light"),
    ],
)
async def test_fixes_dr_strategy_on_database(
    as_user, make_user, make_project, db_session, compliance, expected_scale, expected_strategy
):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(
        db_session,
        project,
        non_functional={
            "budget": "$5,000/month",
            "compliance": compliance,
            "teamMaturity": "small team",
            "expectedScale": expected_scale,
        },
    )
    await _make_architecture(db_session, project, [_database_component({"drStrategy": "none"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "No disaster-recovery strategy for a system that can't afford extended downtime",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "database")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["drStrategy"] == expected_strategy


async def test_fixes_dr_routing_policy_on_dns(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(
        db_session,
        project,
        non_functional={
            "budget": "$5,000/month",
            "compliance": "99.99% availability required",
            "teamMaturity": "small team",
            "expectedScale": "1,000 users",
        },
    )
    await _make_architecture(db_session, project, [_dns_component({"routingPolicy": "Simple"})])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "dns",
            "findingTitle": "No disaster-recovery strategy for a system that can't afford extended downtime",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    fixed = next(c for c in resp.json()["architecture"]["hld"]["components"] if c["id"] == "dns")
    assert fixed["cloudMappings"]["aws"]["lld"]["config"]["routingPolicy"] == "Latency-based routing with health-check failover"


async def test_dr_fix_rejected_for_kubernetes_no_convention_exists(as_user, make_user, make_project, db_session):
    """Kubernetes/private never got DR support built in (Phase 5 scope decision) -- there's no
    correct value to set, so this must 400, not silently apply a made-up config."""
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(
        db_session,
        project,
        non_functional={
            "budget": "$5,000/month",
            "compliance": "99.99% availability required",
            "teamMaturity": "small team",
            "expectedScale": "1,000 users",
        },
    )
    db = _database_component({"drStrategy": "none"})
    db["cloudMappings"]["kubernetes"] = db["cloudMappings"].pop("aws")
    await _make_architecture(db_session, project, [db])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "No disaster-recovery strategy for a system that can't afford extended downtime",
            "provider": "kubernetes",
        },
    )

    assert resp.status_code == 400


async def test_rejects_unknown_finding_title(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component()])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={"componentId": "database", "findingTitle": "Not a real finding", "provider": "aws"},
    )

    assert resp.status_code == 400


async def test_rejects_nonexistent_component(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component()])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "does-not-exist",
            "findingTitle": "Database has no explicit encryption configuration recorded",
            "provider": "aws",
        },
    )

    assert resp.status_code == 404


async def test_404s_when_no_architecture_exists_yet(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "Database has no explicit encryption configuration recorded",
            "provider": "aws",
        },
    )

    assert resp.status_code == 400


async def test_fix_only_touches_the_target_component_and_provider(as_user, make_user, make_project, db_session):
    """The patch must be scoped exactly -- every other component, and every other provider's
    mapping on the SAME component, stays byte-for-byte untouched."""
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    db = _database_component({"encryptionInTransit": "NOT_SET_YET"})
    db["cloudMappings"]["azure"] = {
        "serviceName": "Azure SQL",
        "alternatives": [],
        "costEstimate": {"min": 10, "max": 20},
        "lld": {"config": {"encryptionInTransit": "already fine"}, "reasoning": {}},
    }
    auth = _auth_component({"mfaRequired": "false"})
    await _make_architecture(db_session, project, [db, auth])

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "Database has no explicit encryption configuration recorded",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    components = resp.json()["architecture"]["hld"]["components"]
    fixed_db = next(c for c in components if c["id"] == "database")
    untouched_auth = next(c for c in components if c["id"] == "auth")
    assert fixed_db["cloudMappings"]["aws"]["lld"]["config"]["encryptionInTransit"] == "TLS 1.2+ (Enforced)"
    # Azure's own mapping on the SAME component is untouched.
    assert fixed_db["cloudMappings"]["azure"]["lld"]["config"]["encryptionInTransit"] == "already fine"
    # A completely different component is untouched.
    assert untouched_auth["cloudMappings"]["aws"]["lld"]["config"]["mfaRequired"] == "false"


async def test_creates_a_new_architecture_version(as_user, make_user, make_project, db_session):
    owner = await make_user()
    project = await make_project(user=owner)
    await _make_requirement(db_session, project)
    await _make_architecture(db_session, project, [_database_component()], version="0.1.0")

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/architectures/security-fix",
        json={
            "componentId": "database",
            "findingTitle": "Database has no explicit encryption configuration recorded",
            "provider": "aws",
        },
    )

    assert resp.status_code == 201
    assert resp.json()["architecture"]["version"] == "0.1.1"
