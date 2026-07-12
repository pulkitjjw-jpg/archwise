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
    functional: Any
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
