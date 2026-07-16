from app.models import (
    ApiKey,
    Architecture,
    Conversation,
    Project,
    ProjectComment,
    ProjectMembership,
    Requirement,
    ShareLink,
    User,
    Webhook,
)


def serialize_user(u: User) -> dict:
    # Deliberately excludes clerk_user_id -- an internal sync key the frontend has no use for
    # (it already knows its own Clerk identity directly from Clerk's own hooks).
    return {
        "id": str(u.id),
        "email": u.email,
        "isAdmin": u.is_admin,
        "createdAt": u.created_at,
    }


def serialize_project(p: Project) -> dict:
    return {
        "id": str(p.id),
        "name": p.name,
        "owner": p.owner,
        "createdAt": p.created_at,
        "currentVersion": p.current_version,
        "knowledgeLevel": p.knowledge_level,
        "hasExistingSystem": p.has_existing_system,
    }


def serialize_conversation(c: Conversation) -> dict:
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "role": c.role,
        "message": c.message,
        "stage": c.stage,
        "suggestedReplies": c.suggested_replies,
        "createdAt": c.created_at,
    }


def serialize_requirement(r: Requirement) -> dict:
    return {
        "id": str(r.id),
        "projectId": str(r.project_id),
        "functional": r.functional,
        "nonFunctional": r.non_functional,
        "industryContext": r.industry_context,
        "existingSystem": r.existing_system,
        "productDomain": r.product_domain,
        "version": r.version,
        "conversationSummary": r.conversation_summary,
        "conversationSummarySources": r.conversation_summary_sources,
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
        "flowStory": a.flow_story,
        "flowStorySources": a.flow_story_sources,
        "journeySteps": a.journey_steps,
        "layoutOverrides": a.layout_overrides,
        "securityFindings": a.security_findings,
        "migrationRoadmap": a.migration_roadmap,
        "createdAt": a.created_at,
    }


def serialize_share_link(s: ShareLink) -> dict:
    return {
        "id": str(s.id),
        "projectId": str(s.project_id),
        "token": s.token,
        "createdAt": s.created_at,
        "revokedAt": s.revoked_at,
    }


def serialize_project_membership(m: ProjectMembership) -> dict:
    return {
        "id": str(m.id),
        "projectId": str(m.project_id),
        "userId": str(m.user_id),
        "role": m.role,
        "invitedByUserId": str(m.invited_by_user_id) if m.invited_by_user_id else None,
        "createdAt": m.created_at,
    }


def serialize_project_comment(c: ProjectComment) -> dict:
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "authorUserId": str(c.author_user_id) if c.author_user_id else None,
        "body": c.body,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
    }


def serialize_api_key(k: ApiKey) -> dict:
    # Deliberately excludes key_hash (never useful to a caller) AND the raw key itself (never
    # stored at all past the creation response -- see POST /auth/me/api-keys). key_prefix is the
    # only "which key is this" hint this response ever carries.
    return {
        "id": str(k.id),
        "name": k.name,
        "keyPrefix": k.key_prefix,
        "createdAt": k.created_at,
        "lastUsedAt": k.last_used_at,
        "revoked": k.revoked_at is not None,
        "revokedAt": k.revoked_at,
    }


def serialize_webhook(w: Webhook) -> dict:
    # Deliberately excludes secret -- never returned again after creation (see POST
    # /auth/me/webhooks), same "shown once" precedent as the API key's raw value above.
    return {
        "id": str(w.id),
        "url": w.url,
        "eventTypes": w.event_types,
        "createdAt": w.created_at,
        "disabled": w.disabled_at is not None,
        "disabledAt": w.disabled_at,
    }
