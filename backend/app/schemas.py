from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreateRequest(BaseModel):
    name: str
    ideaText: str
    # Workstream T5 -- "I have an existing system" intake toggle. hasExistingSystem alone (with
    # no text) is still meaningful: it locks Project.has_existing_system so the brainstorm asks
    # about the current stack/deployment/pain points as part of its normal questions, rather than
    # requiring the description be dumped in one block up front.
    hasExistingSystem: bool = False
    existingSystemText: str | None = None


class ConversationCreateRequest(BaseModel):
    role: str
    message: str
    stage: str


class RequirementsPutRequest(BaseModel):
    # Was `Any` -- both real callers (RequirementsPanel's manual edit, the What-If Simulator's
    # "Make this real") always send a plain string array; Pydantic now rejects anything else at
    # the boundary instead of letting an arbitrary JSON shape reach save_requirements and get
    # persisted into the JSONB column unchecked.
    functional: list[str]
    nonFunctional: dict[str, Any]
    # Optional -- omitted by the existing Requirements tab edit flow (which never touches
    # industry/compliance context), but the What-If Simulator's "Make this real" needs a way to
    # persist a changed industry/compliance selection too. When omitted, the save endpoint carries
    # the latest saved industryContext forward unchanged, exactly as it always has.
    industryContext: dict[str, Any] | None = None


class WhatIfPreviewRequest(BaseModel):
    functional: list[str]
    nonFunctional: dict[str, Any]
    industryContext: dict[str, Any]
    # Freeform text for anything that doesn't map to a structured field (e.g. "add multi-region
    # failover") -- folded into the functional requirements list server-side, the same channel
    # the rules engine and LLM already read capability descriptions from.
    additionalContext: str | None = None


# Strict validation for the manual architecture editor's request body -- a deliberate
# improvement over the pre-split app's ad-hoc `if (!components || !connections)` check, per the
# migration plan. Kept intentionally shallow: lld.config/lld.reasoning stay untyped
# Dict[str, str] rather than per-component-type schemas (that's a scope-creep trap with no
# payoff -- see cloud_mapping.py/lld_rules.py's own arbitrary string-keyed config shape).
class CostEstimate(BaseModel):
    min: float
    max: float
    assumptions: str = ""


class ProviderAlternative(BaseModel):
    serviceName: str
    reason: str = ""
    costEstimate: CostEstimate | None = None


class LldSpec(BaseModel):
    config: dict[str, str] = Field(default_factory=dict)
    reasoning: dict[str, str] = Field(default_factory=dict)


class ProviderMapping(BaseModel):
    serviceName: str
    alternatives: list[ProviderAlternative] = Field(default_factory=list)
    costEstimate: CostEstimate | None = None
    lld: LldSpec | None = None
    swapReasoning: str | None = None


class CloudMappings(BaseModel):
    aws: ProviderMapping | None = None
    azure: ProviderMapping | None = None
    gcp: ProviderMapping | None = None
    kubernetes: ProviderMapping | None = None
    private: ProviderMapping | None = None


class Component(BaseModel):
    id: str
    name: str
    type: str
    description: str = ""
    reasoning: str = ""
    service: str | None = None
    rulesFired: list[str] | None = None
    metadata: dict[str, Any] | None = None
    cloudMappings: CloudMappings | None = None


class Connection(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    protocol: str | None = None


class ManualArchitectureRequest(BaseModel):
    components: list[Component]
    connections: list[Connection]


# Manual Editor Controls (Workstream W) -- the client sends its CURRENT draft (which may already
# include manual edits not yet saved), not just the last-persisted architecture, so suggestions
# track the in-progress editing session.
class ComponentSuggestionsRequest(BaseModel):
    components: list[Component]
    connections: list[Connection]


class ProposeChangesRequest(BaseModel):
    description: str
    provider: str


class OriginalProposal(BaseModel):
    action: str
    componentId: str
    componentType: str
    componentName: str
    reasoning: str


class DiscussionMessage(BaseModel):
    role: str
    text: str


class RefineProposalRequest(BaseModel):
    originalProposal: OriginalProposal
    discussionMessage: str
    priorMessages: list[DiscussionMessage] = Field(default_factory=list)
    provider: str


class LayoutOverrideRequest(BaseModel):
    componentId: str
    x: float
    y: float


class EmailExportAttachment(BaseModel):
    """Only present for client-generated exports (docs markdown, diagram image) -- the browser
    already built these (see ArchitectureWorkspace.tsx's handleExportFlowDocs / image export) and
    has no reason to ask the backend to regenerate them just to attach them to an email. For
    terraform/kubernetes/executive-summary, the backend regenerates server-side (same functions
    the direct-download routes already use) and this field is ignored."""

    filename: str
    contentBase64: str
    mimeType: str


class EmailExportRequest(BaseModel):
    format: str  # "terraform" | "kubernetes" | "executive-summary" | "docs" | "image"
    provider: str = "aws"
    attachment: EmailExportAttachment | None = None


class ExportJobRequest(BaseModel):
    """Enqueues a server-generated export job (see POST /projects/{project_id}/export/jobs).
    Deliberately only covers the SERVER_GENERATED_FORMATS subset (terraform/kubernetes/
    executive-summary) -- docs/image exports are already generated client-side and downloaded
    directly, no job needed."""

    format: str  # "terraform" | "kubernetes" | "executive-summary"
    provider: str = "aws"


# RegisterRequest/LoginRequest/ForgotPasswordRequest/ResetPasswordRequest/ChangePasswordRequest
# removed -- Clerk owns credentials, sessions, and email verification entirely now (see
# app/dependencies.py's get_current_user).


class UpdateAppSettingsRequest(BaseModel):
    appName: str = Field(min_length=1, max_length=80)


class UpdateUserAdminRequest(BaseModel):
    isAdmin: bool


class DeleteAccountRequest(BaseModel):
    # Confirmation step for a destructive, irreversible action -- no existing precedent in this
    # codebase for "are you sure" on a destructive action, so this is a deliberately cheap one:
    # require the caller to type their own email back, checked against current_user.email
    # server-side (see DELETE /auth/me). Prevents a stray/scripted DELETE from silently nuking an
    # account -- a plain boolean confirm=true flag is too easy to send by accident/automation.
    confirmEmail: str


class ApiKeyCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class WebhookCreateRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    # At least one -- a webhook subscribed to nothing would never fire, which is almost certainly
    # a mistake worth rejecting up front rather than silently accepting a useless registration.
    eventTypes: list[str] = Field(min_length=1)


class MemberInviteRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    role: str  # "editor" | "viewer" -- "owner" is reserved for Project.user_id, never invitable


class CommentCreateRequest(BaseModel):
    body: str = Field(min_length=1, max_length=10000)
