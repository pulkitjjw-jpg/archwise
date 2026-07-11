from app.models import Architecture, Conversation, Project, Requirement


def serialize_project(p: Project) -> dict:
    return {
        "id": str(p.id),
        "name": p.name,
        "owner": p.owner,
        "createdAt": p.created_at,
        "currentVersion": p.current_version,
    }


def serialize_conversation(c: Conversation) -> dict:
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "role": c.role,
        "message": c.message,
        "stage": c.stage,
        "createdAt": c.created_at,
    }


def serialize_requirement(r: Requirement) -> dict:
    return {
        "id": str(r.id),
        "projectId": str(r.project_id),
        "functional": r.functional,
        "nonFunctional": r.non_functional,
        "industryContext": r.industry_context,
        "version": r.version,
        "createdAt": r.created_at,
    }


def serialize_architecture(a: Architecture) -> dict:
    return {
        "id": str(a.id),
        "projectId": str(a.project_id),
        "version": a.version,
        "hld": a.hld,
        "reasoning": a.reasoning,
        "cloudProvider": a.cloud_provider,
        "createdAt": a.created_at,
    }
