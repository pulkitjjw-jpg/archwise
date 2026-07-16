"""HTTP-level tests for app/routers/collaboration.py: membership invite/list/revoke (owner-only
management, broader listing) and comment create/list/delete (accessible-to-any-member, with
author-or-owner delete gating)."""

import uuid

import pytest

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------


async def test_invite_member_by_owner_succeeds(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    invitee = await make_user(email="invitee@example.com")

    client = as_user(owner)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "invitee@example.com", "role": "editor"}
    )

    assert resp.status_code == 201
    assert resp.json()["member"]["userId"] == str(invitee.id)
    assert resp.json()["member"]["role"] == "editor"


async def test_invite_member_rejects_invalid_role(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    await make_user(email="invitee2@example.com")
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "invitee2@example.com", "role": "owner"}
    )

    assert resp.status_code == 400


async def test_invite_member_404s_for_unknown_email(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "nobody-signed-in-ever@example.com", "role": "editor"}
    )

    assert resp.status_code == 404


async def test_invite_member_409s_on_duplicate_invite(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    await make_user(email="dup@example.com")
    client = as_user(owner)

    resp1 = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "dup@example.com", "role": "editor"}
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "dup@example.com", "role": "viewer"}
    )
    assert resp2.status_code == 409


async def test_invite_member_is_owner_only_not_editor(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    editor = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=editor.id, role="editor"))
    await db_session.commit()
    await make_user(email="target@example.com")

    client = as_user(editor)
    resp = await client.post(
        f"/api/v1/projects/{project.id}/members", json={"email": "target@example.com", "role": "viewer"}
    )

    # get_owned_project (strict) backs this route -- an editor is not the owner, so 404.
    assert resp.status_code == 404


async def test_list_members_visible_to_any_member(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    viewer = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=viewer.id, role="viewer"))
    await db_session.commit()

    client = as_user(viewer)
    resp = await client.get(f"/api/v1/projects/{project.id}/members")

    assert resp.status_code == 200
    assert len(resp.json()["members"]) == 1


async def test_revoke_member_removes_access(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    member = await make_user()
    membership = ProjectMembership(project_id=project.id, user_id=member.id, role="editor")
    db_session.add(membership)
    await db_session.commit()
    await db_session.refresh(membership)

    client = as_user(owner)
    resp = await client.delete(f"/api/v1/projects/{project.id}/members/{membership.id}")
    assert resp.status_code == 200
    assert resp.json()["revoked"] is True

    # The revoked member can no longer even see the project.
    client2 = as_user(member)
    resp2 = await client2.get(f"/api/v1/projects/{project.id}")
    assert resp2.status_code == 404


async def test_revoke_member_404s_for_unknown_membership(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.delete(f"/api/v1/projects/{project.id}/members/{uuid.uuid4()}")

    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


async def test_create_and_list_comments(as_user, make_user, make_project):
    owner = await make_user()
    project = await make_project(user=owner)
    client = as_user(owner)

    resp = await client.post(f"/api/v1/projects/{project.id}/comments", json={"body": "Looks good"})
    assert resp.status_code == 201
    assert resp.json()["comment"]["body"] == "Looks good"

    resp_list = await client.get(f"/api/v1/projects/{project.id}/comments")
    assert resp_list.status_code == 200
    assert len(resp_list.json()["comments"]) == 1


async def test_comment_author_can_delete_own_comment(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    member = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=member.id, role="editor"))
    await db_session.commit()

    client = as_user(member)
    resp = await client.post(f"/api/v1/projects/{project.id}/comments", json={"body": "My comment"})
    comment_id = resp.json()["comment"]["id"]

    resp_delete = await client.delete(f"/api/v1/projects/{project.id}/comments/{comment_id}")
    assert resp_delete.status_code == 200


async def test_project_owner_can_moderate_delete_others_comment(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    member = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=member.id, role="editor"))
    await db_session.commit()

    member_client = as_user(member)
    resp = await member_client.post(f"/api/v1/projects/{project.id}/comments", json={"body": "member comment"})
    comment_id = resp.json()["comment"]["id"]

    owner_client = as_user(owner)
    resp_delete = await owner_client.delete(f"/api/v1/projects/{project.id}/comments/{comment_id}")
    assert resp_delete.status_code == 200


async def test_non_author_non_owner_cannot_delete_comment(as_user, make_user, make_project, db_session):
    from app.models import ProjectMembership

    owner = await make_user()
    project = await make_project(user=owner)
    author = await make_user()
    other_member = await make_user()
    db_session.add(ProjectMembership(project_id=project.id, user_id=author.id, role="editor"))
    db_session.add(ProjectMembership(project_id=project.id, user_id=other_member.id, role="editor"))
    await db_session.commit()

    author_client = as_user(author)
    resp = await author_client.post(f"/api/v1/projects/{project.id}/comments", json={"body": "author comment"})
    comment_id = resp.json()["comment"]["id"]

    other_client = as_user(other_member)
    resp_delete = await other_client.delete(f"/api/v1/projects/{project.id}/comments/{comment_id}")
    assert resp_delete.status_code == 403
